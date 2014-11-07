var childProcess = require('child_process');

var async = require('async');

/**
 * Checks if the git repo in the specified directory is up to date with origin/master
 * @param directory {string} full path to the directory of the git repo
 * @param callback {function} callback(err, upToDate)
 */
function checkRepoUpToDate(directory, callback) {

    async.auto({
        fetch: [function(next) {
            childProcess.exec('git fetch', {cwd: directory}, function (err, stdout, stderr) {
                next(err);
            });
        }],
        localCommitDate: ['fetch', function(next) {
            childProcess.exec('git log --pretty=format:\'%ad\' -n 1 master', {cwd: directory}, function (err, stdout, stderr) {
                next(err, stdout);
            });
        }],
        masterCommitDate: ['fetch', function(next) {
            childProcess.exec('git log --pretty=format:\'%ad\' -n 1 origin/master', {cwd: directory}, function (err, stdout, stderr) {
                next(err, stdout);
            });
        }]
    }, function(err, results) {
        var upToDate = !err && results.localCommitDate && results.masterCommitDate && Date.parse(results.localCommitDate) >= Date.parse(results.masterCommitDate);
        callback(err, upToDate);
    });
}

module.exports = {
    checkRepoUpToDate: checkRepoUpToDate
};