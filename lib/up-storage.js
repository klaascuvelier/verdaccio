var URL = require('url')
  , request = require('request')
  , stream = require('stream')
  , UError = require('./error').UserError
  , mystreams = require('./streams')
  , Logger = require('./logger')
  , utils = require('./utils')

//
// Implements Storage interface
// (same for storage.js, local-storage.js, up-storage.js)
//
function Storage(config, mainconfig) {
	if (!(this instanceof Storage)) return new Storage(config)
	this.config = config
	this.is_alive = true
	this.userAgent = mainconfig.user_agent
	this.ca = config.ca
	this.logger = Logger.logger.child({sub: 'out'})
	this.server_id = mainconfig.server_id

	this.url = URL.parse(this.config.url)
	if (this.url.hostname === 'registry.npmjs.org') {
		this.ca = this.ca || require('./npmsslkeys')

		// npm registry is too slow working with ssl :(
		/*if (this.config._autogenerated) {
			// encrypt all the things!
			this.url.protocol = 'https'
			this.config.url = URL.format(this.url)
		}*/
	}

	_setupProxy.call(this, this.url.hostname, config, mainconfig, this.url.protocol === 'https:')

	this.config.url = this.config.url.replace(/\/$/, '')
	if (isNaN(parseFloat(this.config.timeout)) || !isFinite(this.config.timeout)) {
		this.config.timeout = 30000
	}
	return this
}

function _setupProxy(hostname, config, mainconfig, isHTTPS) {
	var no_proxy
	var proxy_key = isHTTPS ? 'https_proxy' : 'http_proxy'

	// get http_proxy and no_proxy configs
	if (proxy_key in config) {
		this.proxy = config[proxy_key]
	} else if (proxy_key in mainconfig) {
		this.proxy = mainconfig[proxy_key]
	}
	if ('no_proxy' in config) {
		no_proxy = config.no_proxy
	} else if ('no_proxy' in mainconfig) {
		no_proxy = mainconfig.no_proxy
	}

	// use wget-like algorithm to determine if proxy shouldn't be used
	if (hostname[0] !== '.') hostname = '.' + hostname
	if (typeof(no_proxy) === 'string' && no_proxy.length) {
		no_proxy = no_proxy.split(',')
	}
	if (Array.isArray(no_proxy)) {
		for (var i=0; i<no_proxy.length; i++) {
			var no_proxy_item = no_proxy[i]
			if (no_proxy_item[0] !== '.') no_proxy_item = '.' + no_proxy_item
			if (hostname.lastIndexOf(no_proxy_item) === hostname.length - no_proxy_item.length) {
				if (this.proxy) {
					this.logger.debug({url: this.url.href, rule: no_proxy_item}, 'not using proxy for @{url}, excluded by @{rule} rule')
					this.proxy = false
				}
				break
			}
		}
	}

	// if it's non-string (i.e. "false"), don't use it
	if (typeof(this.proxy) !== 'string') {
		delete this.proxy
	} else {
		this.logger.debug({url: this.url.href, proxy: this.proxy}, 'using proxy @{proxy} for @{url}')
	}
}

Storage.prototype.request = function(options, cb) {
	if (!this.status_check()) {
		var req = new stream.Readable()
		process.nextTick(function() {
			if (typeof(cb) === 'function') cb(new Error('uplink is offline'))
			req.emit('error', new Error('uplink is offline'))
		})
		// preventing 'Uncaught, unspecified "error" event'
		req.on('error', function(){})
		return req
	}

	var self = this
	  , headers = options.headers || {}
	headers.Accept = headers.Accept || 'application/json'
	headers['User-Agent'] = headers['User-Agent'] || this.userAgent

	var method = options.method || 'GET'
	  , uri = options.uri_full || (this.config.url + options.uri)
	self.logger.info({
		method: method,
		headers: headers,
		uri: uri,
	}, "making request: '@{method} @{uri}'")

	if (utils.is_object(options.json)) {
		var json = JSON.stringify(options.json)
		headers['Content-Type'] = headers['Content-Type'] || 'application/json'
	}

	var req = request({
		url: uri,
		method: method,
		headers: headers,
		body: json,
		ca: this.ca,
		proxy: this.proxy,
		timeout: this.config.timeout
	}, function(err, res, body) {
		var error
		if (!err) {
			var res_length = body.length

			if (options.json && res.statusCode < 300) {
				try {
					body = JSON.parse(body)
				} catch(_err) {
					body = {}
					err = _err
					error = err.message
				}
			}

			if (!err && utils.is_object(body)) {
				if (body.error) {
					error = body.error
				}
			}
		} else {
			error = err.message
		}

		var msg = '@{!status}, req: \'@{request.method} @{request.url}\''
		if (error) {
			msg += ', error: @{!error}'
		} else {
			msg += ', bytes: @{bytes.in}/@{bytes.out}'
		}
		self.logger.warn({
			err: err,
			request: {method: method, url: uri},
			level: 35, // http
			status: res != null ? res.statusCode : 'ERR',
			error: error,
			bytes: {
				in: json ? json.length : 0,
				out: res_length || 0,
			}
		}, msg)
		if (cb) cb.apply(self, arguments)
	})
	req.on('response', function(res) {
		if (!req._sinopia_aborted) self.status_check(true)
	})
	req.on('error', function() {
		if (!req._sinopia_aborted) self.status_check(false)
	})
	return req
}

Storage.prototype.status_check = function(alive) {
	if (arguments.length === 0) {
		return true // hold off this feature until v0.6.0

		if (!this.is_alive && Math.abs(Date.now() - this.is_alive_time) < 2*60*1000) {
			return false
		} else {
			return true
		}
	} else {
		if (this.is_alive && !alive) {
			this.logger.warn({host: this.url.host}, 'host @{host} is now offline')
		} else if (!this.is_alive && alive) {
			this.logger.info({host: this.url.host}, 'host @{host} is back online')
		}

		this.is_alive = alive
		this.is_alive_time = Date.now()
	}
}

Storage.prototype.can_fetch_url = function(url) {
	url = URL.parse(url)

	return url.protocol === this.url.protocol
	    && url.host === this.url.host
	    && url.path.indexOf(this.url.path) === 0
}

Storage.prototype.add_package = function(name, metadata, options, callback) {
	if (typeof(options) === 'function') callback = options, options = {}

	this.request({
		uri: '/' + escape(name),
		method: 'PUT',
		json: metadata,
	}, function(err, res, body) {
		if (err) return callback(err)
		if (!(res.statusCode >= 200 && res.statusCode < 300)) {
			return callback(new Error('bad status code: ' + res.statusCode))
		}
		callback(null, body)
	})
}

Storage.prototype.add_version = function(name, version, metadata, tag, options, callback) {
	if (typeof(options) === 'function') callback = options, options = {}

	this.request({
		uri: '/' + escape(name) + '/' + escape(version) + '/-tag/' + escape(tag),
		method: 'PUT',
		json: metadata,
	}, function(err, res, body) {
		if (err) return callback(err)
		if (!(res.statusCode >= 200 && res.statusCode < 300)) {
			return callback(new Error('bad status code: ' + res.statusCode))
		}
		callback(null, body)
	})
}

Storage.prototype.add_tarball = function(name, filename, options) {
	if (!options) options = {}

	var stream = new mystreams.UploadTarballStream()
	  , self = this

	var wstream = this.request({
		uri: '/' + escape(name) + '/-/' + escape(filename) + '/whatever',
		method: 'PUT',
		headers: {
			'Content-Type': 'application/octet-stream'
		},
	})

	wstream.on('response', function(res) {
		if (!(res.statusCode >= 200 && res.statusCode < 300)) {
			return stream.emit('error', new UError({
				msg: 'bad uplink status code: ' + res.statusCode,
				status: 500,
			}))
		}
		stream.emit('success')
	})

	wstream.on('error', function(err) {
		stream.emit('error', err)
	})

	stream.abort = function() {
		process.nextTick(function() {
			if (wstream.req) {
				wstream._sinopia_aborted = true
				wstream.req.abort()
			}
		})
	}
	stream.done = function() {}
	stream.pipe(wstream)

	return stream
}

Storage.prototype.get_package = function(name, options, callback) {
	if (typeof(options) === 'function') callback = options, options = {}

	var headers = {}
	if (options.etag) {
		headers['If-None-Match'] = options.etag
	}
	this._add_proxy_headers(options.req, headers)

	this.request({
		uri: '/' + escape(name),
		json: true,
		headers: headers,
	}, function(err, res, body) {
		if (err) return callback(err)
		if (res.statusCode === 404) {
			return callback(new UError({
				msg: 'package doesn\'t exist on uplink',
				status: 404,
			}))
		}
		if (!(res.statusCode >= 200 && res.statusCode < 300)) {
			return callback(new Error('bad status code: ' + res.statusCode))
		}
		callback(null, body, res.headers.etag)
	})
}

Storage.prototype.get_tarball = function(name, options, filename) {
	if (!options) options = {}
	return this.get_url(this.config.url + '/' + name + '/-/' + filename)
}

Storage.prototype.get_url = function(url) {
	var stream = new mystreams.ReadTarballStream()
	stream.abort = function() {}

	var rstream = this.request({
		uri_full: url,
		encoding: null,
		headers: {
			Accept: 'application/octet-stream',
		},
	})

	rstream.on('response', function(res) {
		if (res.statusCode === 404) {
			return stream.emit('error', new UError({
				msg: 'file doesn\'t exist on uplink',
				status: 404,
			}))
		}
		if (!(res.statusCode >= 200 && res.statusCode < 300)) {
			return stream.emit('error', new UError({
				msg: 'bad uplink status code: ' + res.statusCode,
				status: 500,
			}))
		}

		rstream.pipe(stream)
	})

	rstream.on('error', function(err) {
		stream.emit('error', err)
	})
	return stream
}

Storage.prototype._add_proxy_headers = function(req, headers) {
	if (req) {
		headers['X-Forwarded-For'] = (
			(req && req.headers['x-forwarded-for']) ?
			req.headers['x-forwarded-for'] + ', ' :
			''
		) + req.connection.remoteAddress
	}

	// always attach Via header to avoid loops, even if we're not proxying
	headers['Via'] =
		(req && req.headers['via']) ?
		req.headers['via'] + ', ' :
		''

	headers['Via'] += '1.1 ' + this.server_id + ' (Sinopia)'
}

module.exports = Storage
