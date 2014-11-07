'use strict';
//TODO: parts of this code is duplicated within mediary; we'll want our own module instead of duplicate code

var fs      = require('fs');
var path    = require('path');

var knox    = require('knox');
var mime    = require('mime');

// Set up our custom mime times for fonts
mime.define({
    'application/x-font-opentype': ['otf','eot','ttf'],
    'image/svg+xml': ['svg'],
    'application/font-woff': ['woff']
});

/**
 * Constructs a wrapped S3 client for the given bucket and credentials
 * @param {string} bucket bucket for the S3 client (default: env.AMAZON_S3_BUCKET)
 * @param {string} key AWS credentials key (default: env.AMAZON_S3_KEY)
 * @param {string} secret AWS credentials secret (default: env.AMAZON_S3_SECRET)
 * @constructor
 */
function S3(bucket, key, secret) {
    var config = {
        key: key,
        secret: secret,
        bucket: bucket
    };
    this.bucket = bucket;
    this.client = knox.createClient(config);
}

/**
 * Enables mapping of bucket to cloudfront.
 * If value is non-null, urlWithBucket() will now map to a cloudfront url
 * @param cloudfrontMapping the cloudfront subdomain the S3 bucket is mapped to
 */
S3.prototype.setCloudfrontMapping = function(cloudfrontMapping){
    this.cloudfrontMapping = cloudfrontMapping;
};

/**
 * Gets the bucket in use by the S3 client
 * @returns {string} the name of the bucket in use
 */
S3.prototype.getBucket = function() {
    return this.bucket;
};

/**
 * Uploads the given text contents to S3
 * @param {string|Buffer} contents the text or buffer to upload
 * @param {string} path the path the contents should be saved to
 * @param {bool|object} makePrivateOrHeaders whether or not to make the file private on S3; or the full set of heders to use.
 * @param {function} callback function(err, url)
 */
S3.prototype.putBuffer = function(contents, path, makePrivateOrHeaders, callback) {

    if (typeof makePrivateOrHeaders === 'function') {
        callback = makePrivateOrHeaders;
        makePrivateOrHeaders = false;
    }

    path = _cleanPath(path);

    var self = this;
    var buffer = contents instanceof Buffer ? contents : new Buffer(contents);

    self.client.putBuffer(buffer, path, _createHeaders(makePrivateOrHeaders), function(err, result) {
        if (!err && (!result || result.statusCode !== 200)) {
            err = new Error('Status code other 200 from AWS: '+result.statusCode);
        }

        callback(err, result && self.urlWithBucket(path));
    });
};

/**
 * Uploads a file to S3
 * @param {string} sourcePath the path of the file to upload
 * @param {string} targetPath the path of where the file should be saved on S3
 * @param {bool|object} makePrivateOrHeaders whether or not to make the file private on S3; or the full set of heders to use.
 * @param {function} callback function(err, url)
 * @returns {object} fileUpload object that emits "progress" events with percent, written, and total properties
 */
S3.prototype.putFile = function(sourcePath, targetPath, makePrivateOrHeaders, callback) {

    if (typeof makePrivateOrHeaders === 'function') {
        callback = makePrivateOrHeaders;
        makePrivateOrHeaders = false;
    }

    targetPath = _cleanPath(targetPath);

    var self = this;
    var stream = fs.createReadStream(sourcePath);

    var headers = _createHeaders(makePrivateOrHeaders, targetPath);
    headers['Content-Length'] = fs.statSync(sourcePath).size;

    var fileUpload = self.client.putStream(stream, targetPath, headers, function(err, result){
        callback(err, result && self.urlWithBucket(targetPath));
    });

    return fileUpload;
};

/**
 * Checks whether or not a file exists on S3
 * @param {string} path the path within the S3 bucket to check
 * @param {function} callback function(err, fileExists)
 */
S3.prototype.fileExists = function(path, callback) {

    var self = this;

    path = _cleanPath(path);

    // we check the file be retrieving its header information
    self.client.headFile(path, function(err, response) {
        callback(err, response && response.statusCode === 200);
    });

};

/**
 * Returns the full url given an S3 path
 * @param {string} path path within the S3 bucket
 * @returns {string} url to the s3 path (or mapped cloudfront path)
 */
S3.prototype.urlWithBucket = function(path) {
    path = path || '';
    // for the web, forward slashes are king
    path = path.replace(/\\/g, '/');
    if (path[0] === '/') {
        path = path.substr(1);
    }
    return this.cloudfrontMapping
        ? 'https://'+this.cloudfrontMapping+'.cloudfront.net/'+path
        : 'https://s3.amazonaws.com/'+this.bucket.toLowerCase()+'/'+path;
};

function _createHeaders(makePrivateOrHeaders, targetPath) {

    var headers = {};
    var contentType = targetPath && mime.lookup(targetPath);
    if (typeof makePrivateOrHeaders === 'object') {
        headers = makePrivateOrHeaders;
    } else if (!makePrivateOrHeaders) {
        headers['x-amz-acl'] = 'public-read';
    }

    // some intelligent header setting based on the path
    if (!headers['Content-Type'] && contentType) {
        headers['Content-Type'] = contentType;
    }

    return headers;
}

function _cleanPath(path) {
    // cleans path in case generated in windows environment
    return path && path.replace(/\\/g,'/');
}

module.exports = S3;