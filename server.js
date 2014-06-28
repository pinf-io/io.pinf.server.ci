
const PATH = require("path");
const FS = require("fs");
const REQUEST = require("request");
const WAITFOR = require("waitfor");
const PARSE_LINK_HEADER = require("parse-link-header");


require("io.pinf.server.www").for(module, __dirname, function(app, config, HELPERS) {

	config = config.config;

    const DB_NAME = "devcomp";

    /*
    function callGithub(userInfo, method, path, callback) {
        var url = path;
        if (/^\//.test(url)) {
        	url = "https://api.github.com" + path;
        }
        return REQUEST({
        	method: method,
            url: url,
            headers: {
                "User-Agent": "nodejs/request",
                "Authorization": "token " + userInfo.accessToken
            },
            json: true
        }, function (err, res, body) {
            if (err) return callback(err);
            if (res.statusCode === 403 || res.statusCode === 404) {
                console.error("Got status '" + res.statusCode + "' for url '" + url + "'! This is likely due to NOT HAVING ACCESS to this API call because your OAUTH SCOPE is too narrow! See: https://developer.github.com/v3/oauth/#scopes", res.headers);
                var scope = null;
                if (/^\/repos\/([^\/]+)\/([^\/]+)\/hooks$/.test(path)) {
                    scope = "write:repo_hook";
                }
                if (scope) {
                    console.log("We are going to start a new oauth session with the new require scope added ...");
                    var err = new Error("Insufficient privileges. Should start new session with added scope: " + scope);
                    err.code = 403;
                    err.requestScope = scope;
                    return callback(err);
                }
                return callback(new Error("Insufficient privileges. There should be a scope upgrade handler implemented for url '" + url + "'!"));
            }
        	if (res.headers.link) {
        		var link = PARSE_LINK_HEADER(res.headers.link);
        		if (link) {
        			if (!res.nav) res.nav = {}
        			if (link.prev) res.nav.prev = link.prev.url;
        			if (link.next) res.nav.next = link.next.url;
        		}
        	}
            return callback(null, res, body);
        });
    }
    */

    function ensureHookForRepository (userInfo, r, org, repo, callback) {

    	/*
    	// TODO: We may want to use the webhooks api instead of posting to pubsub links every time
    	//       we need to verify that hooks are created.
        return callGithub(userInfo, "GET", "/repos/" + org + "/" + repo + "/hooks", function(err, res, hooks) {
            if (err) return callback(err);
			
			console.log("hooks", hooks);

	        return callGithub(userInfo, "POST", "/repos/" + org + "/" + repo + "/hooks", {

	        }, function(err, res, result) {
	            if (err) return callback(err);

				console.log("result", result);
	        });
        });
		*/

		var subscribeUrl = "https://api.github.com/hub";
		return REQUEST({
			method: "POST",
            url: subscribeUrl,
            headers: {
                "User-Agent": "nodejs/request"
            },
            form: {
        		"hub.mode": "subscribe",
        		"hub.topic": "https://github.com/" + org + "/" + repo + "/events/push",
        		"hub.callback": HELPERS.makePublicklyAccessible(config.notificationUrl)
            },
            auth: {
            	user: "user",
            	pass: userInfo.accessToken
            }
        }, function (err, res, body) {
            if (err) return callback(err);
            if (res.statusCode === 422) {
                console.error("Got status '" + res.statusCode + "' for url '" + subscribeUrl + "'! This is likely due to NOT HAVING ACCESS to this API call because your OAUTH SCOPE is too narrow! See: https://developer.github.com/v3/oauth/#scopes", res.headers);
                var scope = "write:repo_hook";
                if (scope) {
                    console.log("We are going to start a new oauth session with the new require scope added ...");
                    var err = new Error("Insufficient privileges. Should start new session with added scope: " + scope);
                    err.code = 403;
                    err.requestScope = scope;
                    return callback(err);
                }
                return callback(new Error("Insufficient privileges. There should be a scope upgrade handler implemented for url '" + url + "'!"));
            }
            if (res.statusCode !== 204) {
                return callback(new Error("Got status '" + res.statusCode + "' while creating hook!"));
            }
        	// Hook successfully created!
			return callback(null);
        });
    }

    function hookRepositories(userInfo, r, callback) {
    	if (!config.watch) {
    		console.log("No repositories to watch configured!");
    		return callback(null);
    	}
		return r.tableEnsure(DB_NAME, "io_pinf_server_ci", "repositories", function(err, repositoryTable) {
            if (err) return callback(err);
	        var waitfor = WAITFOR.parallel(callback);

	        // Go through all deployed services and see if a repository is declared.
	        // If repository is also found as being watched then we record it in
	        // the database and register a github post-commit hook.

	        // TODO: Use pinf-it based data here.
			var deployedServices = JSON.parse(FS.readFileSync(PATH.join(__dirname, "../.pio.json"))).config["pio.services"].services;
			for (var serviceId in deployedServices) {
				var serviceDescriptor = deployedServices[serviceId].descriptor;
				if (
					serviceDescriptor.repository &&
					serviceDescriptor.repository.url
				) {
					var m = serviceDescriptor.repository.url.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)$/);
					if (m) {
						if (config.watch.organizations[m[1]]) {
							console.log("Watch repository '" + m[1] + "' for organization '" + m[1] + "'.");
				        	waitfor(m, function(m, callback) {
								return repositoryTable.insert({
			                		id: "github.com/" + m[1] + "/" + m[2]
			                	}, {
			                        upsert: true
			                    }).run(r.conn, function (err, result) {
			                        if (err) return callback(err);
									return ensureHookForRepository(userInfo, r, m[1], m[2], callback);
			                    });	
				        	});
						} else {
							console.log("Found repository '" + m[1] + "' for organization '" + m[1] + "' but not configured to watch.");
						}
					} else {
						console.log("Repository url format not supported: " + serviceDescriptor.repository.url);
					}
				}
			}
	        return waitfor();
	    });
    }

    app.post("/notify", function (req, res, next) {

// TODO: Ensure repo is in DB and then log new commit in db.
// TODO: Write commit watcher for db that then triggers a build (one at a time).

console.log("NOTIFY req.body", JSON.stringify(JSON.parse(req.body.payload), null, 4));

		return res.end();
    });

    // TODO: Convert this into a trigger route.
	app.use(function(req, res, next) {

		if (res.view && res.view.authorized) {

			if (res.view.authorized.github) {

				console.log("Hook repositories with access token from user:", res.view.authorized.github.username);

				return hookRepositories(res.view.authorized.github, res.r, function (err) {
					if (err) {
						console.error("Error hooking repositories", err.stack);
						return next(err);
					}
					console.log("Repository hooking done");
					return res.end();
				});
			}
		}

		return next();
	});

});
