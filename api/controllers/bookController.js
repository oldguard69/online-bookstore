const { body, validationResult } = require('express-validator');
const { findOne, query, countData, loadDataForSideNav, loadGenresAndPublishers } = require('../database/db_hepler');
const { preprocessBookList, calculateOffsetForPagination,
     handleError, isResultEmpty, sendErrorResponseMessage,
    sendSuccessResponseMessage, getQueryParam, handleValidationError } = require('../shared/helper');
const pool = require('../config/pool');
const Q = require('../database/query');


exports.sidenav = async (req, res) => {
    try {
        const sidenav = await Promise.resolve(loadDataForSideNav());
        res.status(200).json(sidenav);
    } catch (err) {
        console.error(err);
    }
}

exports.indexBookList = async (req, res) => {
    try {
        let books = [];
        const bookPerPage = parseInt(req.query.pagesize) || 30;
        const currentPage = parseInt(req.query.page) || 0;
        const offset = calculateOffsetForPagination(bookPerPage, currentPage);
        const count = await countData(Q.book.bookCount);
        if (count > 0) {
            books = preprocessBookList(await query(Q.book.indexBookList, [offset, bookPerPage]));
        }
        // convert authors from array to string
        for (let i = 0; i < books.length; i++) {
            books[i].Authors = books[i].Authors.map(author => author.fullname).join(', ');
        }

        const data = {
            "booklist": books, totalItem: count
        }
        res.status(200).json(data);
    } catch (err) {
        handleError(res, 500, err);
    }
}

exports.sideAdBooklist = async (req, res) => {
    try {
        const booklist = await query(Q.book.sideAdBooklist, [0, 10]);
        res.status(200).json({ booklist });
    } catch (err) {
        handleError(res, 500, err);
    }
};

exports.bookDetail = async (req, res) => {
    try {
        const isbn = processIsbn(req.params.isbn);
        const numberOfRecommendBook = 5;
        const book = preprocessBookList(await query(Q.book.bookDetail, [isbn]))[0];
        if (isResultEmpty(book)) {
            // return res.status(404).json({ message: 'Page not found' });
            return sendErrorResponseMessage(res, ['Page not found']);
        }
        const recommendBook = preprocessBookList(await query(Q.book.recommendBook,
            [book.Publisher.publisher_id, book.Genre.genre_id, isbn, numberOfRecommendBook]));
        res.status(200).json({ success: true, book, recommendBook });
    } catch (error) {
        handleError(res, 500, error);
    }
};

exports.bookDelete = async (req, res) => {
    try {
        const result = await query(Q.book.deleteBook, [processIsbn(req.params.isbn)]);
        if (result.affectedRows !== 0) {
            sendSuccessResponseMessage(res, ['Sách đã được xóa.']);
        } else {
            sendErrorResponseMessage(res, ['Some server errors happen. Please try again later'])
        }
    } catch (err) {
        handleError(res, 500, err);
    }
};

exports.bookSearch = async (req, res) => {
    try {
        const rawSearchText = req.query.search;
        const bookPerPage = parseInt(getQueryParam(req, 'pagesize', 10));
        const currentPage = parseInt(getQueryParam(req, 'page', 0));
        const offset = calculateOffsetForPagination(bookPerPage, currentPage);
        if (undefined === rawSearchText) {
            return sendErrorResponseMessage(res, ['Vui lòng điền vào từ khóa để tìm kiếm.']);
        }

        const searchText = rawSearchText.replace(/\+/gi, ' ');
        const count = await countData(Q.book.bookSearchCount, [searchText, searchText]);
        const books = await query(Q.book.bookSearch, [searchText, searchText, offset, bookPerPage]);
        res.json({ success: true, books, totalItems: count });
    } catch (err) {
        handleError(res, 500, err);
    }
};

exports.book = async (req, res) => {
    try {
        const isbn = processIsbn(req.params.isbn);
        const book = preprocessBookList(await query(Q.book.bookDetail, [isbn]))[0];
        if (isResultEmpty(book)) {
            return sendErrorResponseMessage(res, [`Sách với isbn ${isbn} không tồn tại trong hệ thống.`]);
        }
        res.json({ success: true, book });
    } catch (err) {
        handleError(res, 500, err);
    }
};

exports.fetchGenresAndPublishers = async (req, res) => {
    try {
        const { genres, publishers } = await Promise.resolve(loadGenresAndPublishers())
        res.json({ 'success': true, genres, publishers });
    } catch (error) {
        handleError(res, 500, error);
    }
}

function validateOnBookForm() {
    return [
        body('isbn', 'ISBN is invalid').trim().not().isEmpty().withMessage('Vui lòng điền isbn.').isISBN().withMessage('isbn không hợp lệ.'),
        body('name').trim().not().isEmpty().withMessage('Vui lòng điền tên sách.').escape(),
        body('image_url').trim().optional({ checkFalsy: true }),
        body('summary').trim().optional({ checkFalsy: true }).escape(),
        body('author').trim().escape(),
        body('genre_id').isInt().withMessage('Mã thể loại không hợp lệ.'),
        body('publisher_id').isInt().withMessage('Mã nhà xuất bản không hợp lệ.')
    ]
}

exports.bookCreate = [
    ...validateOnBookForm(),
    async (req, res) => {
        const connection = await pool.getConnection();
        try {
            const formData = getInputDataOnCreateOrUpdate(req);
            const validationError = validationResult(req);
            if (!validationError.isEmpty()) {
                return handleValidationError(res, validationError);
            } else {
                const checkBook = await findOne(Q.book.bookByIsbn, [formData.isbn]);
                if (!isResultEmpty(checkBook)) {
                    const err = [`Đã tồn tại sách với ISBN: ${formData.isbn}. Vui lòng kiểm tra lại`];
                    sendErrorResponseMessage(res, err);
                } else {
                    const authorArray = convertAuthorsFromStringToArray(formData.author);
                    await connection.query(Q.startTransaction);

                    await connection.query(Q.book.createBook, [
                        formData.isbn, formData.name, formData.image_url,
                        formData.summary, formData.genre_id, formData.publisher_id
                    ]);
                    for (let index = 0; index < authorArray.length; index++) {
                        const element = authorArray[index];
                        updateAuthor(connection, element, formData.isbn);
                    }

                    await connection.query(Q.commit);
                    sendSuccessResponseMessage(res, ['Thêm sách thành công.']);
                }
            }
        } catch (err) {
            await connection.query(Q.rollback);
            console.log(err);
            const errorMsg = ['Đã xảy ra lỗi ở server. Vui lòng thêm sách lại.'];
            sendErrorResponseMessage(res, errorMsg);
        } finally {
            connection.release();
        }
    } // end of async function
];

exports.bookUpdate = [
    ...validateOnBookForm(),
    async (req, res) => {
        const formData = getInputDataOnCreateOrUpdate(req);

        const connection = await pool.getConnection();
        const currentIsbn = processIsbn(req.params.isbn);
        const validationError = validationResult(req);
        if (!validationError.isEmpty()) {
            return handleValidationError(res, validationError);
        }
        try {
            // if isbn has changed, then check whether isbn is exist in database
            if (formData.isbn !== currentIsbn) {
                const checkISBN = await findOne(Q.book.bookByIsbn, [formData.isbn]);
                const oldBook = await findOne(Q.book.bookByIsbn, [currentIsbn]);
                // isbn in url send from client does not exist in database;
                if (isResultEmpty(oldBook)) {
                    return sendErrorResponseMessage(res, ['book not found']);
                }

                // input isbn change and there is already an isbn like this in database
                if (!isResultEmpty(checkISBN)) {
                    const error = [`Đã tồn tại sách với ISBN ${formData.isbn} trong hệ thống. Vui lòng kiểm tra lại.`];
                    return sendErrorResponseMessage(res, error);
                }
            } else {
                // connection = await pool.getConnection();
                await connection.query(Q.startTransaction);

                await connection.query(Q.book.deleteAuthorFromWrittens, [formData.isbn]);
                await connection.query(Q.book.updateBook, [
                    formData.isbn, formData.name, formData.image_url, formData.summary,
                    formData.genre_id, formData.publisher_id, currentIsbn
                ]);
                const authorArray = convertAuthorsFromStringToArray(formData.author);
                for (let i = 0; i < authorArray.length; i++) {
                    const authorName = authorArray[i];
                    updateAuthor(connection, authorName, formData.isbn);
                }

                await connection.query(Q.commit);
                sendSuccessResponseMessage(res, ['Cập nhật thông tin sách thành công.']);
            }
        } catch (err) {
            await connection.query(Q.rollback);
            console.log(err);
            const errorMsg = ['Đã xảy ra lỗi ở server. Vui lòng cập nhật lại.'];
            sendSuccessResponseMessage(res, errorMsg);
        } finally {
            await connection.release();
        }
    }
];

/* create import stock form 
    loop through array
        check if isbn is valid
            insert into stockdetail*/
exports.importBookStock = async (req, res) => {
    try {
        
    } catch (err) {
        handleError(res, 500, err);
    }
};

async function updateAuthor(connection, authorName, isbn) {
    const temp = await connection.query(Q.author.authorByFullname, [authorName]); // temp = [[{author_id, fullname}], , ]
    const author = temp[0][0];
    if (isResultEmpty(author)) {
        const result = await connection.query(Q.author.createAuthor, [authorName, null]);
        await connection.query(Q.book.written, [isbn, result.insertId]);
    } else {
        await connection.query(Q.book.written, [isbn, author.author_id]);
    }
}


function convertAuthorsFromStringToArray(authorsArray) {
    return authorsArray
        .trim().split(',')
        .filter(author => author !== "")
        .map(author => author.trim());
}

function getInputDataOnCreateOrUpdate(req) {
    return {
        isbn: processIsbn(req.body.isbn),
        name: req.body.name,
        image_url: req.body.image_url || `/images/no_image.png`,
        summary: req.body.summary || null,
        genre_id: parseInt(req.body.genre_id),
        publisher_id: parseInt(req.body.publisher_id),
        author: req.body.author
    };
}

function processIsbn(isbn) {
    return isbn.replace(/ |-/gi, '');
}