const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);

//set up environment
require('dotenv').config();
const database = require('./database');
const app = express();

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
	res.render('homepage');
});

//admin dashboard
app.get('/dashboard', function(req, res) {
  if (!req.session.user || req.session.user.role !== 'admin') res.redirect('/');

  res.render('dashboard');
});

//admin route for making a quiz
app.get('/addquiz', function(req, res) {
  if (!req.session.user || req.session.user.role !== 'admin') res.redirect('/');

  res.render('quiz/add.ejs');
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
    res.redirect('/');
  });
});

//make server listen
app.listen(process.env.PORT || 80, function(err) {
  if (err) return console.log(err);

  console.log("app started on port " + (process.env.PORT || 80));
});