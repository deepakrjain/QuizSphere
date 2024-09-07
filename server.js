const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const app = express();
const session = require('express-session');
const bodyParser = require('body-parser');

app.use(bodyParser.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));  // Assuming your views are in the 'views' folder

// Session Middleware
app.use(session({
    secret: 'your-secret-key',  // Replace with your own secret key
    resave: false,
    saveUninitialized: true
}));

// Parse incoming request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Create MySQL connection
const connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'root',     // Replace with your MySQL password
    database: 'quiz_system'
});

// Connect to MySQL
connection.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL database:', err);
        return;
    }
    console.log('Connected to MySQL database.');
});

app.post('/signup', (req, res) => {
    const { email, password, role, name } = req.body;
    // Check if the email already exists
    const sqlCheck = 'SELECT * FROM users WHERE email = ?';
    connection.query(sqlCheck, [email], (err, results) => {
        if (err) {
            console.error('Error checking email:', err);
            return res.json({ success: false, message: 'Error checking email.' });
        }

        if (results.length > 0) {
            return res.json({ success: false, message: 'Email already exists.' });
        }
        // Insert new user with name
        const sqlInsert = 'INSERT INTO users (email, password, role, username) VALUES (?, ?, ?, ?)';
        connection.query(sqlInsert, [email, password, role, name], (err, result) => {
            if (err) {
                console.error('Error registering user:', err);
                return res.json({ success: false, message: 'Error registering user.' });
            }

            return res.json({ success: true, role }); // Return the role to the client
        });
        const user = results[0];
        req.session.userId = user.id; // Ensure this is set correctly
        req.session.role = user.role;
        req.session.userEmail = user.email;
    });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;

    const sqlCheck = `SELECT * FROM users WHERE email = ? AND password = ?`;
    connection.query(sqlCheck, [email, password], (err, results) => {
        if (err) {
            console.error("Error logging in: ", err);
            return res.json({ success: false, message: 'Error logging in.' });
        }

        if (results.length > 0) {
            const user = results[0];
            req.session.userId = user.id; // Ensure this is set correctly
            req.session.role = user.role;
            req.session.userEmail = user.email;
            console.log("User logged in with ID : ", req.session.userId); // Debug log
            if (user.role === 'student') {
                return res.json({ success: true, redirectUrl: '/studentportal' });
            } else if (user.role === 'teacher') {
                return res.json({ success: true, redirectUrl: '/teacherportal' });
            }
        } else {
            return res.json({ success: false, message: 'Invalid credentials.' });
        }
    });
});

app.post('/create-quiz', (req, res) => {
    if (req.session.role === 'teacher' && req.session.userId) {
        const teacher_id = req.session.userId;
        const { title, questions, options, correct_answers } = req.body;

        if (!title || !questions || !options || !correct_answers) {
            return res.status(400).send('All fields are required');
        }

        // Start a transaction to ensure all queries succeed or fail together
        connection.beginTransaction((err) => {
            if (err) throw err;

            // Insert the quiz into the quizzes table
            const quizSql = 'INSERT INTO quizzes (title, teacher_id) VALUES (?, ?)';
            connection.query(quizSql, [title, teacher_id], (err, quizResult) => {
                if (err) {
                    connection.rollback(() => { throw err; });
                }

                const quiz_id = quizResult.insertId;  // Get the inserted quiz ID

                // Insert each question with its options into the questions table
                let questionPromises = questions.map((question, index) => {
                    const questionSql = 'INSERT INTO questions (quiz_id, question_text, correct_option) VALUES (?, ?, ?)';
                    return new Promise((resolve, reject) => {
                        connection.query(questionSql, [quiz_id, question, correct_answers[index]], (err, questionResult) => {
                            if (err) {
                                return reject(err);
                            }

                            const question_id = questionResult.insertId;

                            // Insert options for this question
                            const optionPromises = options[index].map((option) => {
                                const optionSql = 'INSERT INTO options (question_id, option_text) VALUES (?, ?)';
                                return new Promise((resolve, reject) => {
                                    connection.query(optionSql, [question_id, option], (err, result) => {
                                        if (err) return reject(err);
                                        resolve();
                                    });
                                });
                            });

                            // Wait for all options to be inserted
                            Promise.all(optionPromises).then(resolve).catch(reject);
                        });
                    });
                });

                // Wait for all questions and their options to be inserted
                Promise.all(questionPromises).then(() => {
                    connection.commit((err) => {
                        if (err) {
                            connection.rollback(() => { throw err; });
                        }
                        res.redirect('/teacherportal');
                    });
                }).catch((err) => {
                    connection.rollback(() => { throw err; });
                });
            });
        });
    } else {
        res.status(403).send('Unauthorized access or session expired');
    }
});

app.post('/submit-quiz/:quizId', (req, res) => {
    console.log('Form data:', req.body);
    console.log('Answers:', req.body.answers);

    const quizId = req.params.quizId; // quiz ID from URL params
    const quizTitle = req.params.quizTitle; // quiz ID from URL params
    const studentId = req.body.studentId; // student ID from the form body
    const answers = req.body.answers;

    console.log("Submitted Data:", req.body);
    console.log("Submitted Answers:", answers); // Debugging: Log the submitted answers

    // Get the correct answers from the database for the specified quiz
    const correctAnswers = `
        SELECT q.id as question_id, q.correct_option
        FROM questions q
        WHERE q.quiz_id = ?
    `;

    connection.query(correctAnswers, [quizId], (err, results) => {
        if (err) throw err;

        console.log('Correct Answers from DB:', results); // Debugging: Log the correct answers

        let score = 0;
        let noOfQ = 0;

        // Loop through each question to compare the student's answer with the correct answer
        results.forEach(({ question_id, correct_option }, index) => {
            noOfQ++;
            const submittedAnswer = answers[index]; // Access using array index
            const mappedAnswer = parseInt(submittedAnswer) % 4; // Your suggested logic
            if (mappedAnswer == 0) {
                mappedAnswer = 1;
            }
            const correctAnswer = correct_option; // Correct answer from the database

            console.log(`Question ID: ${question_id}, Submitted: ${mappedAnswer}, Correct: ${correctAnswer}`); // Log each comparison

            // Use == for comparison to handle type mismatch (e.g., '1' == 1)
            if (mappedAnswer === correctAnswer) {
                score++;
            }
        });

        console.log('Final Score:', score); // Debugging: Log the final calculated score

        // Insert or update the student's quiz attempt in the database
        const attemptQuery = `
            INSERT INTO quiz_attempts (student_id, quiz_id, score)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE score = VALUES(score)
        `;

        connection.query(attemptQuery, [studentId, quizId, score], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    res.send("You have already attempted this quiz.");
                } else {
                    throw err;
                }
            } else {
                const resultsQuery = `
                INSERT INTO results (quiz_id, student_id, score)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE score = VALUES(score)
            `;

                connection.query(resultsQuery, [quizId, studentId, score], (err) => {
                    if (err) throw err;
                    // Fetch the leaderboard (students' scores) for the quiz
                    const leaderboardQuery = `
                    SELECT u.username, qa.score
                    FROM quiz_attempts qa
                    JOIN users u ON qa.student_id = u.id
                    WHERE qa.quiz_id = ?
                    ORDER BY qa.score DESC
                `;

                    connection.query(leaderboardQuery, [quizId], (err, leaderboardResults) => {
                        if (err) throw err;

                        // Render the leaderboard view, passing the leaderboard data
                        res.render('leaderboard', {
                            leaderboard: leaderboardResults,
                            quizTitle: quizTitle,
                            quizId: quizId,
                            studentScore: score,
                            totalQuestions: noOfQ
                        });
                    });
                }
            )};
        });
    });
});

app.get('/api/leaderboard/:quizId', (req, res) => {
    console.log('leaderboard called');
    const quizId = req.params.quizId;
    const leaderboardQuery =
        `SELECT u.username, r.score
        FROM results r
        JOIN users u ON r.student_id = u.id
        WHERE r.quiz_id = ?
        ORDER BY r.score DESC`
        ;
    connection.query(leaderboardQuery, [quizId], (err, results) => {
        console.log(results)
        if (err) throw err;
        res.json(results);
    });
});

app.get('/quizzes', (req, res) => {
    const getQuizzesQuery = 'SELECT id, title FROM quizzes';
    connection.query(getQuizzesQuery, (err, results) => {
        if (err) {
            console.error('Error fetching quizzes:', err);
            return res.status(500).json({ error: 'Failed to load quizzes' });
        }
        res.json(results);  // Return the list of quizzes as JSON
    });
});

// Serve student portal
app.get('/studentportal', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'studentportal.html'));
});

app.get('/teacherportal', (req, res) => {
    const query = 'SELECT * FROM quizzes';
    connection.query(query, (err, quizzes) => {
        if (err) throw err;
        // Render the teacher portal with quizzes
        res.render('teacherportal', { quizzes });
    });
});

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running on port http://localhost:${PORT}`);
});

app.get('/take-quiz/:quizId', (req, res) => {
    const quizId = req.params.quizId;
    const userEmail = req.session.userEmail; // User's email from session

    // Fetch the student_id from users table
    const getUserQuery = "SELECT id FROM users WHERE email = ? AND role = 'student'";
    connection.query(getUserQuery, [userEmail], (err, result) => {
        if (err) throw err;

        if (result.length > 0) {
            const studentId = result[0].id;

            // Check if the student has already taken the quiz
            const checkTakenQuery = "SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ?";
            connection.query(checkTakenQuery, [quizId, studentId], (err, resultsTaken) => {
                if (err) throw err;

                if (resultsTaken.length > 0) {
                    // Student has already taken the quiz, redirect to view results
                    res.redirect(`/view-results/${quizId}`);
                } else {
                    // Fetch the quiz questions and options
                    const quizQuery = `
                        SELECT q.id as question_id, q.question_text, o.id as option_id, o.option_text
                        FROM questions q
                        JOIN options o ON q.id = o.question_id
                        WHERE q.quiz_id = ?
                    `;
                    connection.query(quizQuery, [quizId], (err, results) => {
                        if (err) throw err;

                        // Structure the data for rendering
                        const quizData = results.reduce((acc, row) => {
                            const question = acc.find(q => q.question_id === row.question_id);
                            if (question) {
                                question.options.push({ option_id: row.option_id, option_text: row.option_text });
                            } else {
                                acc.push({
                                    question_id: row.question_id,
                                    question_text: row.question_text,
                                    options: [{ option_id: row.option_id, option_text: row.option_text }]
                                });
                            }
                            return acc;
                        }, []);

                        res.render('take-quiz', { quizId, student_id: studentId, quizData });
                    });
                }
            });
        } else {
            res.send("Student not found or not logged in.");
        }
    });
});

// Delete a quiz
app.delete('/delete-quiz/:id', (req, res) => {
    const quizId = req.params.id;

    // Delete quiz and related questions/options
    const sqlDeleteQuiz = 'DELETE FROM quizzes WHERE id = ?';
    connection.query(sqlDeleteQuiz, [quizId], (err, result) => {
        if (err) {
            console.error('Error deleting quiz:', err);
            return res.status(500).send('Error deleting quiz.');
        }
        res.send('Quiz deleted successfully.');
    });
});
app.get('/view-results/:quizId', (req, res) => {
    const quizId = req.params.quizId;

    const leaderboardQuery = `
        SELECT u.username, qa.score
        FROM quiz_attempts qa
        JOIN users u ON qa.student_id = u.id
        WHERE qa.quiz_id = ?
        ORDER BY qa.score DESC
    `;
    connection.query(leaderboardQuery, [quizId], (err, results) => {
        if (err) throw err;

        res.render('leaderboard', {
            leaderboard: results,
            quizId: quizId
        });
    });
});

app.get('/studentportal', (req, res) => {
    console.log("Session userId:", req.session.userId);  // Debugging log

    if (!req.session.userId) {
        return res.redirect('/login');
    }

    const fetchQuizzesQuery = 'SELECT id, title FROM quizzes';
    connection.query(fetchQuizzesQuery, (err, quizzes) => {
        if (err) {
            console.error('Error fetching quizzes:', err);
            return res.status(500).send('Error fetching quizzes');
        }

        res.render('studentportal', { quizzes: quizzes });
    });
});

app.get('/get-quiz/:id', (req, res) => {
    const quizId = req.params.id;
    console.log('Fetching quiz with ID:', quizId);  // Debugging log

    // Get quiz title and questions
    const quizQuery = 'SELECT title FROM quizzes WHERE id = ?';
    connection.query(quizQuery, [quizId], (err, quizResult) => {
        if (err) {
            console.error('Error fetching quiz:', err);  // Error log
            return res.status(500).send('Error fetching quiz');
        }

        if (quizResult.length > 0) {
            const quiz = quizResult[0];

            // Get the questions and their options
            const questionsQuery =
                `SELECT q.id AS question_id, q.question_text, GROUP_CONCAT(o.option_text ORDER BY o.id) AS options
            FROM questions q
            JOIN options o ON q.id = o.question_id
            WHERE q.quiz_id = ?
            GROUP BY q.id`;
            ;
            connection.query(questionsQuery, [quizId], (err, questionResults) => {
                if (err) {
                    console.error('Error fetching questions:', err);  // Error log
                    return res.status(500).send('Error fetching questions');
                }

                const questions = [];
                const questionMap = {};

                questionResults.forEach(row => {
                    if (!questionMap[row.question_id]) {
                        questionMap[row.question_id] = {
                            id: row.question_id,
                            question_text: row.question_text,
                            options: []
                        };
                        questions.push(questionMap[row.question_id]);
                    }
                    questionMap[row.question_id].options.push(row.option_text);
                });

                res.json({
                    title: quiz.title,
                    questions: questions
                });
            });
        } else {
            res.status(404).send('Quiz not found');
        }
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/index.html');
});

app.get('/leaderboard/:quizId', (req, res) => {
    res.sendFile(__dirname + '/views/leaderboard.html');
});