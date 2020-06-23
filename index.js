const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const Busboy = require('busboy');
const AWS = require('aws-sdk');

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
//AWS config and making s3
AWS.config.update({
	accessKeyId: process.env.AMAZON_ACCESS_KEY_ID,
	secretAccessKey: process.env.AMAZON_SECRET_KEY
});
const s3 = new AWS.S3({apiVersion: '2006-03-01'});

//setup static routes and body parser
app.use(express.static('public'));
app.use(bodyParser.json({limit: "10mb"}));
app.use(bodyParser.urlencoded({limit: "10mb", extended:true}));
//ejs
app.set('view engine', 'ejs');

//upgrade everything to https
// app.use('*', function(req, res, next) {
//   if (req.protocol === "http") {
// 		res.redirect(301, 'https://' + req.headers.host + req.url);
// 	}
// 	else next();
// });

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
  next();
});

//homepage
app.get('/', function(req, res) {
  database.getQuizInfo(-1, (err, quizzes) => {
    res.render('homepage', {quizzes: quizzes});
  });
});

//quiz
app.get('/quiz/:safeTitle', function(req, res) {
  database.getQuizByTitle(req.params.safeTitle, (err, quiz) => {
    if (err) return res.send(err);

    res.render('quiz/view', {quiz: quiz, title:quiz.title+" | Quizonality"});
  });
});

//admin dashboard
app.get('/dashboard', function(req, res) {
  if (!req.session.user || req.session.user.role !== 'admin') res.redirect('/');

  res.render('dashboard');
});

//admin route for making a quiz
app.get('/addquiz', function(req, res) {
  if (!req.session.user || req.session.user.role !== 'admin') res.redirect('/');

  res.render('quiz/add');
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

    //create params to upload to s3
    const params = {
      ACL: "authenticated-read",
      Body: fileData,
      Bucket: "quizonality",
      Key: "thumbs/"+sanatizeString(data.quizTitle)+fileExt
    };
    //upload to s3
    s3.putObject(params, (err, result) => {
      if (err) return res.send(err);

      //the stuff we're gonna upload to the database
      let quizData = {
        ownerId: data.ownerId,
        title: data.quizTitle,
        safeTitle: sanatizeString(data.quizTitle),
        description: data.quizDescription,
        article: data.quizArticle,
        image: "https://quizonality.s3.amazonaws.com/thumbs/"+sanatizeString(data.quizTitle)+fileExt,
        results: data.quizResults,
        questions: data.quizQuestions
      };

      //create the game in the database
      database.addQuiz(quizData, (err, result) => {
        if (err) return res.send(err);

        res.send("ok");//quiz successfully created
      });
    });
  });
});

app.get('/login', function(req, res) {
  if (req.query.err) return res.render('login', {err: decodeURIComponent(req.query.err)});
  res.render('login', { title: 'Login' });
});

app.post('/login', function(req, res) {
  database.loginUser(req.body.username, req.body.password, (err, user) => {
    if (err) return res.redirect('/login?err='+encodeURIComponent(err));

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role
    };
    res.send("quiz added");
  });
});

//make server listen
app.listen(process.env.PORT || 80, function(err) {
  if (err) return console.log(err);

  console.log("app started on port " + (process.env.PORT || 80));
});