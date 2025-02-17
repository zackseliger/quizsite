const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const Busboy = require('busboy');
const fs = require('fs');
const ejs = require('ejs');
const bcrypt = require('bcrypt');
const compression = require('compression')

//global utilities
function sanatizeString(str) {
	//chars we should remove
 	const removeChars = ["~", "`", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "=", "+", "[", "{", "]",
					 "}", "\\", "|", ";", ":", "\"", "'", "&#8216;", "&#8217;", "&#8220;", "&#8221;", "&#8211;", "&#8212;",
					 "â€”", "â€“", ",", "<", ">", "/", "?", "."];
	//chars we should replace with a dash
	const dashChars = [' '];
	let result = JSON.parse(JSON.stringify(str));

	//sanitize the string
	for (let i = 0; i < removeChars.length; i++) {
		result = result.split(removeChars[i]).join('');
	}
	for (let i = 0; i < dashChars.length; i++) {
		result = result.split(dashChars[i]).join('-');
	}

	return result.toLowerCase();
}
//utility busboy function
function parseFormData(req, callback) {
	let busboy = new Busboy({headers: req.headers});
	let data = {};

	//put files in buffers
	busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
		//create path based on file extension
		let path = fieldname+filename.slice(filename.lastIndexOf('.'));
		let fileData = Buffer.alloc(0);

		//get file data
		file.on('data', (chunk) => {
			fileData = Buffer.concat([fileData, chunk], fileData.length + chunk.length);
		});
		file.on('end', () => {
			data[path] = fileData;
		});
	});
	//non-file inputs
	busboy.on('field', (fieldname, val) => {
		data[fieldname] = val;
	});
	busboy.on('finish', () => {
		callback(null, data);
	});

	req.pipe(busboy);
}

//set up environment
require('dotenv').config();
const database = require('./database');
const app = express();

//all of our templates
let renderQuizTemplate = fs.readFileSync('./views/templates/renderQuizzes.ejs', 'utf-8');
app.locals.renderQuizzes = function(quizzes) {
	return ejs.render(renderQuizTemplate, { quizzes });
}

//setup static routes and body parser
app.use(express.static('public'));
app.use(bodyParser.json({limit: "10mb"}));
app.use(bodyParser.urlencoded({limit: "10mb", extended:true}));
app.use(compression());//zlib/gzip compression for responses
//ejs
app.set('view engine', 'ejs');

//for each request, if they have a 'www.' before the rest of the domain, remove it
app.use('/', (req, res, next) => {
  if (req.headers.host && req.headers.host.slice(0, 4) === 'www.') {
    const newHost = req.headers.host.slice(4);
    return res.redirect(301, req.protocol + '://' + newHost + req.originalUrl);
  }
  next();
});

//session store and session
const sessionStore = new MySQLStore({
	host: process.env.DB_HOST,
	port: 3306,
	user: process.env.DB_USER,
	password: process.env.DB_PASS,
	database: process.env.DB_NAME
});
const sessionOptions = {
	key: 'user',
	secret: process.env.SECRET,
	store: sessionStore,
	resave: false,
	saveUninitialized: true,
	rolling: true,
	cookie: {
		secure: false,
		maxAge: 86400000,//one day
	}
};
app.use(session(sessionOptions));

//global stuff
app.use('*', (req, res, next) => {
	//remove 'www.' before rest of domain
	if (req.headers.host && req.headers.host.slice(0, 4) === 'www.') {
		const newHost = req.headers.host.slice(4);
		return res.redirect(301, req.protocol + '://' + newHost + req.originalUrl);
	}
	res.locals.myuser = req.session.user;//put 'myuser' in locals so ejs can access it
	res.locals.adsensePubId = process.env.ADSENSE_PUB_ID;//publisher id for adsense
	next();
});

//homepage
app.get('/', function(req, res) {
	database.getQuizInfo(-1, (err, quizzes) => {
		if (err) return res.send(err);

		res.render('homepage', {quizzes: quizzes});
	});
});

//view quiz
app.get('/quiz/:safeTitle', function(req, res) {
	database.getQuizByTitle(req.params.safeTitle, (err, quiz) => {
		if (err) return res.send(err);
		database.getQuizInfo(10, (err, quizzes) => {
			if (err) return res.send(err);

			//make sure quiz id for 'more quizzes' doesn't match the current quiz
			for (let i = 0; i < quizzes.length; i++) {
				if (quizzes[i].id === quiz.id) {
					quizzes.splice(i, 1);
					break;
				}
			}

			quiz.url = req.protocol + '://' + req.get('host') + req.originalUrl;
			quiz.imageUrl = req.protocol + '://' + req.get('host') + quiz.image;
			res.render('quiz/view', {quiz: quiz, title:quiz.title+" | Quizonality", moreQuizzes: quizzes});
		});
	});
});

//admin page for quizzes
app.get('/quiz/:safeTitle/admin', function(req, res) {
	if (!req.session.user || req.session.user.role !== 'admin') res.redirect('/');

	database.getQuizByTitle(req.params.safeTitle, (err, quiz) => {
		if (err) return res.send(err);

		res.render('quiz/add-admin', {quiz: quiz});//the add page can also edit quizzes
	});
});

app.post('/quiz/:safeTitle/admin', function(req, res) {
	if (!req.session.user || req.session.user.role !== 'admin') res.redirect('/');

	parseFormData(req, (err, data) => {
		if (err) return res.send(err);

		//get property with the thumbnail and set a path for it
		let dataKeys = Object.keys(data);
		let fileData = null;
		let fileExt = "";
		dataKeys.map((val) => { if (val.indexOf('quizImage.') !== -1) { fileData = data[val]; fileExt = "."+val.slice(10); } });

		//we have to get the old quiz to delete the old image or compare data
		database.getQuizByTitle(req.params.safeTitle, (err, quiz) => {
			if (err) return res.send(err);

			//properties to update for sure
			let newQuiz = {
				title: data.quizTitle,
				safeTitle: sanatizeString(data.quizTitle),
				description: data.quizDescription
			};
			//properties that can be a lot of data if we don't check first
			if (data.quizArticle !== quiz.article) newQuiz.article = data.quizArticle;
			if (data.quizResults !== quiz.results) newQuiz.results = data.quizResults;
			if (data.quizQuestions !== quiz.questions) newQuiz.questions = data.quizQuestions;

			//if the thumbnail has changed, we need to upload the new image, delete the old one
			if (fileData !== null) {
				newQuiz.image = "/static/thumbs/"+sanatizeString(data.quizTitle)+fileExt;//change file path

				//delete old image and create the new one
				fs.unlink("public"+quiz.image, (err) => (err) ? console.log(err):0 );
				fs.writeFile("public/static/thumbs/"+sanatizeString(data.quizTitle)+fileExt, fileData, (err) => { if (err) console.log(err) });
			}

			database.editQuiz(req.params.safeTitle, newQuiz, (err, result) => {
				if (err) return res.send(err);

				res.send("ok");
			});
		});
	});
});

//post quiz answers, returns quiz results
app.post('/quiz/:safeTitle', function(req, res) {
	database.getQuizByTitle(req.params.safeTitle, (err, quiz) => {
		if (err) return res.send("{'err': '"+err+"'}");

		//get/create quiz variables
		let results = JSON.parse(quiz.results);
		let questions = JSON.parse(quiz.questions);
		let answers = req.body.answers.split(' ');
		let resultsAccum = [];

		//convert answers from strings to ints
		for (let i = 0; i < answers.length; i++) answers[i] = parseInt(answers[i]);
		//initialize all results to 0
		for (let i = 0; i < results.length; i++) resultsAccum[i] = 0;

		//for each question, change acums by the amount each answer effect says to
		for (let i = 0; i < answers.length && i < questions.length; i++) {
			if (!Number.isInteger(answers[i])) continue; //make sure answer is an integer
			if (!questions[i].answers[answers[i]]) continue; //make sure the answer that they said actually exists

			//change accums for each effect
			for (let j = 0; j < questions[i].answers[answers[i]].effects.length; j++) {
				resultsAccum[j] += questions[i].answers[answers[i]].effects[j];
			}
		}

		//get the index with the largest accum
		let largestAccumIndex = 0;
		for (let i = 1; i < resultsAccum.length; i++) {
			if (resultsAccum[i] > resultsAccum[largestAccumIndex]) {
				largestAccumIndex = i;
			}
		}

		//return JSON with a name and a description of the result
		res.send(JSON.stringify(results[largestAccumIndex]));
	});
});

//editing users
app.get('/user/:username/admin', function(req, res) {
	if (!req.session.user || req.session.user.role !== 'admin') res.redirect('/');

	database.getUserByUsername(decodeURIComponent(req.params.username), (err, user) => {
		if (err) return res.send(err);

		res.render('user/admin', {user: user});
	});
});

//the post request to actually change the user
app.post('/user/:username/admin', function(req, res) {
	if (!req.session.user || req.session.user.role !== 'admin') res.redirect('/');

	//the new user's properties
	let newUser = {
		username: req.body.username,
		role: req.body.role
	}

	//if a password was entered, hash it and put it into the new user
	if (req.body.password !== '') {
		bcrypt.hash(req.body.password, 12, (err, hash) => {
			if (err) return res.send(err);

			//get the hash and send data to the database
			newUser.password = hash;
			database.editUser(req.params.username, newUser, (err, result) => {
				if (err) return res.send(err);
				res.redirect('/dashboard');
			});
		});
	}
	//if there's no password, just call the database
	else {
		//send data to the database
		database.editUser(req.params.username, newUser, (err, result) => {
			if (err) return res.send(err);
			res.redirect('/dashboard');
		})
	}
});

//admin dashboard
app.get('/dashboard', function(req, res) {
	if (!req.session.user || req.session.user.role !== 'admin') res.redirect('/');

	database.getQuizInfo(-1, (err, quizzes) => {
		if (err) return res.send(err);
		database.getUsers((err, users) => {
			if (err) return res.send(err);

			res.render('dashboard', {quizzes:quizzes, users:users, title:"Dashboard | Quizonality"});
		})
	});
});

//admin route for making a quiz
app.get('/addquiz', function(req, res) {
	if (!req.session.user || req.session.user.role !== 'admin') res.redirect('/');

	res.render('quiz/add-admin');
});

app.post('/addquiz', function(req, res) {
	if (!req.session.user || req.session.user.role !== 'admin') return res.send("no");

	parseFormData(req, (err, data) => {
		if (err) return res.send(err);

		//get property with the thumbnail and set a path for it
		let dataKeys = Object.keys(data);
		let fileData = null;
		let fileExt = "";
		dataKeys.map((val) => { if (val.indexOf('quizImage.') !== -1) { fileData = data[val]; fileExt = "."+val.slice(10); } });
		if (fileData === null) return res.send("no image upload detected");
		
		//save image to static/thumbs
		fs.writeFile("public/static/thumbs/"+sanatizeString(data.quizTitle)+fileExt, fileData, (err) => { if (err) console.log(err) });

		//the stuff we're gonna upload to the database
		let quizData = {
			ownerId: data.ownerId,
			title: data.quizTitle,
			safeTitle: sanatizeString(data.quizTitle),
			description: data.quizDescription,
			article: data.quizArticle,
			image: "/static/thumbs/"+sanatizeString(data.quizTitle)+fileExt,
			results: data.quizResults,
			questions: data.quizQuestions
		};

		//create the game in the database
		database.addQuiz(quizData, (err, result) => {
			if (err) return res.send(err);

			res.send("ok");//quiz successfully created
		});
		// });
	});
});

app.get('/login', function(req, res) {
	if (req.query.err) return res.render('login', {err: decodeURIComponent(req.query.err)});
	res.render('login', { title: 'Login' });
});

app.get('/logout', function(req, res) {
	req.session.user = null;

  res.redirect('/');
});

app.post('/login', function(req, res) {
	database.loginUser(req.body.username, req.body.password, (err, user) => {
		if (err) return res.redirect('/login?err='+encodeURIComponent(err));

		req.session.user = {
			id: user.id,
			username: user.username,
			role: user.role
		};
		
		res.redirect('/');
	});
});

function manageSite() {
	database.getQuizInfo(-1, (err, quizzes) => {
		if (err) return console.log(err);

		//open file, write home page url
		const writeStream = fs.createWriteStream("./public/sitemap.txt");
		writeStream.write("https://"+process.env.DOMAIN+"\n"); //home page

		//quizzes
		for (let i = 0; i < quizzes.length; i++) {
			writeStream.write("https://"+process.env.DOMAIN+"/quiz/"+quizzes[i].safe_title+"\n");
		}

		writeStream.end();
	});

	//calls itself after a day
	setTimeout(manageSite, 86400000);
}
//call it the first time (wait 1 minute to make sure we have an sql connection)
setTimeout(manageSite, 60000);

//make server listen
app.listen(process.env.PORT || 80, function(err) {
	if (err) return console.log(err);

	console.log("app started on port " + (process.env.PORT || 80));
});