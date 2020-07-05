const mysql = require('mysql2');
const bcrypt = require('bcrypt');

//for email validation
function isValidEmail(email) {
	const re = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
	return re.test(email);
}

//connect to the database, create it if it doesn't already exist
let pool = null;
const conn = mysql.createConnection({
	host: process.env.DB_HOST,
	user: process.env.DB_USER,
	password: process.env.DB_PASS,
	port: 3306,
	charset: "utf8mb4_general_ci"
});
conn.query(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`, function(err, results) {
	if (err) console.log(err);

	pool = mysql.createPool({
		host: process.env.DB_HOST,
		user: process.env.DB_USER,
		password: process.env.DB_PASS,
		database: process.env.DB_NAME,
		port: 3306,
		charset: "utf8mb4_general_ci"
	});

	//create all the cool things in our database like users and quizzes
	queryDatabase(`CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY AUTO_INCREMENT, username TINYTEXT, email TINYTEXT, password TINYTEXT, role VARCHAR(255) DEFAULT 'user');`)
	.then(() => queryDatabase(`SELECT * FROM users`).then((results) => {if (results.length === 0) bcrypt.hash('defaultpassword', 12, (err, hash) => queryDatabase(`INSERT INTO users (username, email, password, role) VALUES ('admin', 'admin@example.com', '${hash}', 'admin');`))}))
	.then(() => queryDatabase(`CREATE TABLE IF NOT EXISTS quizzes (id INT PRIMARY KEY AUTO_INCREMENT, owner_id INT NOT NULL, title TEXT, safe_title TEXT, description TEXT, article TEXT, image TEXT, type INT DEFAULT 0, tags TEXT NOT NULL, results TEXT, questions TEXT);`))
	.catch((err) => console.log(err));
});

//executes query and returns a promise
function queryDatabase(query) {
	return new Promise((resolve, reject) => {
		//query the database, reject if error, else resolve
		pool.query(query, function(err, results, fields) {
			if (err) return reject(err);

			//resolves as an object with results and fields properties
			resolve(results);
		});
	});
}

function createUser(body, callback) {
	//error checking
	if (!body.username || !body.password || !body.email || !body.passwordrepeat)
		return callback('Please fill out all fields');
	if (body.username.indexOf('\'') !== -1 || body.username.indexOf('.') !== -1 || body.username.indexOf(';') !== -1 || body.username.indexOf('%') !== -1)
		return callback('The characters \'.;% are not allowed in usernames');
	if (body.password !== body.passwordrepeat)
		return callback('Password and repeat password do not match');
	if (!isValidEmail(body.email)) return callback('Email is not valid');
	if (!body.password.length || body.password.length < 8)
		return callback('Password must be at least 8 characters long');

	//see if this username or email already exists
	queryDatabase(`SELECT * FROM users WHERE username=${mysql.escape(body.username)};`)
	.then(result => {
		if (result.length != 0) return callback('This username is already in use');

		//see if this email already exists
		queryDatabase(`SELECT * FROM users WHERE email=${mysql.escape(body.email)};`)
		.then(result => {
			if (result.length != 0) return callback('This email is already in use');

			//if this username/email doesn't already exist, we good
			//hash password
			bcrypt.hash(body.password, 12, function(err, hash) {
				if (err) return callback("Password couldn't be hashed, please try again later");
				//make query, modify if user wants a developer account
				let query = `INSERT INTO users (username, email, password) VALUES (${mysql.escape(body.username)}, `
				+ `${mysql.escape(body.email)}, ${mysql.escape(hash)});`;

				//create user in database
				queryDatabase(query)
				.then(result => callback(null, result))
				.catch(err => callback(err));
			});
		})
		.catch(err => callback(err));
	})
	.catch(err => callback(err));
}

function loginUser(username, password, callback) {
	if (!username || !password) return callback('Fill out both fields');

	queryDatabase(`SELECT * from users WHERE username=${mysql.escape(username)}`)
	.then(result => {
		if (result.length === 0) return callback('Bad username or password');
		//one username per user allowed, we can assume there's only one user found
		bcrypt.compare(password, result[0].password, function(err, res) {
			if (err) return callback("Hash couldn't be compared");
			if (res === false) return callback('Bad username or password');

			callback(null, result[0]);
		});
	})
	.catch(err => {
		console.log(err)
		callback(err);
	});
}

//creates a quiz and adds it to the database
function addQuiz(data, callback) {
	if (!data.ownerId || !data.title || !data.safeTitle || !data.description || !data.article || !data.results || !data.questions || !data.image) {
		return callback("missing data. Need id, title, safeTitle, description, article, results, questions, and image properties");
	}

	queryDatabase(`INSERT INTO quizzes (owner_id, title, safe_title, description, article, image, results, questions, tags)`+
	` VALUES (${mysql.escape(data.ownerId)}, ${mysql.escape(data.title)}, ${mysql.escape(data.safeTitle)}, ${mysql.escape(data.description)},`+
	` ${mysql.escape(data.article)}, ${mysql.escape(data.image)}, ${mysql.escape(data.results)}, ${mysql.escape(data.questions)}, '');`)
	.then((results) => callback(null, results))
	.catch((err) => callback(err));
}

//edits the quiz with the original safe_title value
function editQuiz(oldTitle, data, callback) {
	let query = `UPDATE quizzes SET `;
	if (data.title) query += `title=${mysql.escape(data.title)}, `;
	if (data.safeTitle) query += `safe_title=${mysql.escape(data.safeTitle)}, `;
	if (data.description) query += `description=${mysql.escape(data.description)}, `;
	if (data.article) query += `article=${mysql.escape(data.article)}, `;
	if (data.results) query += `results=${mysql.escape(data.results)}, `;
	if (data.questions) query += `questions=${mysql.escape(data.questions)}, `;
	if (data.image) query += `image=${mysql.escape(data.image)}, `;

	//remove last comma and space
	query = query.slice(0, query.length-2);
	
	query += ` WHERE safe_title=${mysql.escape(oldTitle)};`;

	queryDatabase(query)
	.then((results) => callback(null, results))
	.catch((err) => callback(err));
}

//gets 'num' quizzes, -1 to get all of them
//info is the information about the quiz you need to show an info card
function getQuizInfo(num, callback) {
	let query = `SELECT id, title, safe_title, description, image FROM quizzes`;
	if (num !== -1) query += ` ORDER BY RAND() LIMIT ${num}`;
	else query += ` ORDER BY id DESC`;

	queryDatabase(query+";")
	.then((result) => callback(null, result))
	.catch((err) => callback(err));
}

//get quiz by safeTitle. This is the sanatized one for urls
function getQuizByTitle(safeTitle, callback) {
	queryDatabase(`SELECT * FROM quizzes WHERE safe_title=${mysql.escape(safeTitle)} LIMIT 1;`)
	.then((results) => callback(null, results[0]))
	.catch((err) => callback(err));
}

//get all users
function getUsers(callback) {
	queryDatabase(`SELECT * FROM users;`)
	.then((results) => callback(null, results))
	.catch((err) => callback(err));
}

//get user by username
function getUserByUsername(username, callback) {
	queryDatabase(`SELECT * FROM users WHERE username=${mysql.escape(username)};`)
	.then((results) => callback(null, results[0]))
	.catch((err) => callback(err));
}

//edit a user from their old username
function editUser(oldUsername, data, callback) {
	let query = `UPDATE users SET `;
	if (data.username) query += `username=${mysql.escape(data.username)}, `;
	if (data.role) query += `role=${mysql.escape(data.role)}, `;
	if (data.password) query += `password=${mysql.escape(data.password)}, `;

	//remove last comma and space
	query = query.slice(0, query.length-2);
	
	query += ` WHERE username=${mysql.escape(oldUsername)};`;

	queryDatabase(query)
	.then((results) => callback(null, results))
	.catch((err) => callback(err));
}

module.exports = {
	queryDatabase,

	addQuiz,
	editQuiz,
	getQuizInfo,
	getQuizByTitle,

	createUser,
	getUsers,
	getUserByUsername,
	editUser,
	loginUser
}