var Promise = require("bluebird");
var _ = require('underscore');
var logger = require('./util/logger.js');
var mongoPromise = require('./promise/mongoPromise');
var elasticsearchPromise = require('./promise/elasticsearchPromise');
var util = require('./util/util');
var tail = require('./util/tail');
var fsWatcher = require('./util/fsWatcher');
var tailArray = [];

var getDataArrayAsnyc = function (results, file) {
    return new Promise(function (resolve, reject) {
        var mongoResults = [];
        if (results.length > 0) {
            Promise.reduce(results, function (total, item) {
                return new Promise(function (resolve, reject) {
                    var id = item._id.toString();
                    delete item._id;
                    if (file.Content.elasticsearch.e_pipeline && file.Content.elasticsearch.e_iscontainattachment) {
                        mongoPromise.getGridFsArray(util.returnMongodbDataUrl(file.Content.mongodb.m_url, file.Content.mongodb.m_connection,
                            file.Content.mongodb.m_database), id).then(function (result) {
                            logger.logMethod('info', 'Transforming document: ' + JSON.stringify(item));
                            item.attachments = result;
                            mongoResults.push({
                                index: {
                                    _index: file.Content.elasticsearch.e_index,
                                    _type: file.Content.elasticsearch.e_type,
                                    _id: id
                                }
                            }, item);
                            return resolve(mongoResults);
                        });
                    } else {
                        logger.logMethod('info', 'Transforming document: ' + JSON.stringify(item));
                        mongoResults.push({
                            index: {
                                _index: file.Content.elasticsearch.e_index,
                                _type: file.Content.elasticsearch.e_type,
                                _id: id
                            }
                        }, item);
                        return resolve(mongoResults);
                    }
                });
            }, 0).then(function (res) {
                return resolve(res);
            });
        } else {
            return reject('the data must be more than 1');
        }
    });
};

var insertDataToEs = function (currentNum, file) {
    return new Promise(function (resolve, reject) {
        var delayTime = 0;
        var bulkSize = 0;
        if (file.Content.mongodb.m_delaytime) {
            delayTime = file.Content.mongodb.m_delaytime;
        }
        setTimeout(function () {
            var st = new Date().getTime();
            return mongoPromise.getPageDataResult(util.returnMongodbDataUrl(file.Content.mongodb.m_url, file.Content.mongodb.m_connection,
                        file.Content.mongodb.m_database), file.Content.mongodb.m_collectionname, file.Content.mongodb.m_filterfilds,
                    file.Content.mongodb.m_returnfilds, file.Content.mongodb.m_documentsinbatch, currentNum)
                .then(function (results) {
                    return getDataArrayAsnyc(results, file);
                }).then(function (results) {
                    if (results.length > 0) {
                        bulkSize = results.length / 2;
                        if (file.Content.elasticsearch.e_pipeline && file.Content.elasticsearch.e_iscontainattachment) {
                            return elasticsearchPromise.bulkDataAndPip(file.Content.elasticsearch.e_connection.e_server,
                                file.Content.elasticsearch.e_connection.e_httpauth, results, file.Content.elasticsearch.e_pipeline);
                        } else if (file.Content.elasticsearch.e_pipeline && !file.Content.elasticsearch.e_iscontainattachment) {
                            return elasticsearchPromise.bulkDataAndPip(file.Content.elasticsearch.e_connection.e_server,
                                file.Content.elasticsearch.e_connection.e_httpauth, results, file.Content.elasticsearch.e_pipeline);
                        } else {
                            return elasticsearchPromise.bulkData(file.Content.elasticsearch.e_connection.e_server,
                                file.Content.elasticsearch.e_connection.e_httpauth, results);
                        }
                    } else {
                        return false;
                    }
                }).then(function (result) {
                    var flag = false;
                    if (result) {
                        flag = true;
                    }
                    if (global.isTrace) {
                        var et = new Date().getTime();
                        var timer = (et - st) / 1000;
                        logger.logMethod('warn', file.Content.elasticsearch.e_index + "," + "bulk" + "," + bulkSize + "," + timer);
                    }
                    return resolve(flag);
                }).catch(function (err) {
                    return reject(err);
                });
        }, delayTime);
    });
};

var singlePipe = function (file, filePath) {
    return new Promise(function (resolve, reject) {
        util.updateInfoArray(file.Content.elasticsearch.e_connection.e_server, file.Content.elasticsearch.e_index, "", "I");
        elasticsearchPromise.existEsServer(file.Content.elasticsearch.e_connection.e_server,
            file.Content.elasticsearch.e_connection.e_httpauth).then(function (result) {
            if (result) {
                return mongoPromise.getDataCount(util.returnMongodbDataUrl(file.Content.mongodb.m_url, file.Content.mongodb.m_connection,
                    file.Content.mongodb.m_database), file.Content.mongodb.m_collectionname, file.Content.mongodb.m_filterfilds);
            } else {
                logger.errMethod(file.Content.elasticsearch.e_connection.e_server, file.Content.elasticsearch.e_index,
                    "Unable to recieve connection: " + file.Content.elasticsearch.e_connection.e_server);
                return 0;
            }
        }).then(function (result) {
            if (result > 0) {
                logger.logMethod('info', 'Mongodata counts is ' + result);
                var currentNumArray = [];
                if (file.Content.mongodb.m_documentsinbatch > 0) {
                    var totalNum = Math.ceil(result / file.Content.mongodb.m_documentsinbatch);
                    for (var i = 0; i < totalNum; i++) {
                        currentNumArray.push(i);
                    }
                } else {
                    currentNumArray.push(0);
                }
                return Promise.each(currentNumArray, function (currentNum) {
                    return insertDataToEs(currentNum, file);
                });
            } else {
                return false;
            }
        }).then(function (result) {
            var flag = false;
            if (result) {
                flag = true;
                if (!util.contains(tailArray, util.returnMongodbOplogUrl(file.Content.mongodb.m_url, file.Content.mongodb.m_connection))) {
                    tailArray.push(util.returnMongodbOplogUrl(file.Content.mongodb.m_url, file.Content.mongodb.m_connection));
                    tail.tail(file.Content, filePath);
                }
                util.updateInfoArray(file.Content.elasticsearch.e_connection.e_server, file.Content.elasticsearch.e_index, "", "R");
                logger.logMethod('info', 'DataConfig : ' + file.Filename + ' have finished crawl!');
            }
            return resolve(flag);
        }).catch(function(err){
            return resolve(false);
        });
    }).catch(function (err) {
        logger.errMethod(file.Content.elasticsearch.e_connection.e_server, file.Content.elasticsearch.e_index,
            "file error: " + JSON.stringify(file));
        return resolve(err);
    });
};

var init = function (getFileList, filePath) {
    global.isTrace = false;
    logger.logMethod('info', '<-----------------------------Starting initialization----------------------------->');
    Promise.reduce(getFileList, function (total, item, index) {
        return new Promise(function (resolve, reject) {
            singlePipe(item, filePath).then(function (result) {
                if (result) {
                    return resolve(index);
                } else {
                    logger.errMethod(item.Content.elasticsearch.e_connection.e_server, item.Content.elasticsearch.e_index,
                        "DataConfig is error! FileName is : " + item.Filename);
                    return resolve("DataConfig is error! FileName is : " + item.Filename);
                }
            });
        });
    }, 0).then(function () {
        logger.logMethod('info', 'All documents transform have finished!');
        fsWatcher.fsWatcher(filePath);
    });
};

module.exports = {
    init: init,
    singlePipe: singlePipe
};