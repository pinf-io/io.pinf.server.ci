
const PATH = require("path");
const FS = require("fs");
const REQUEST = require("request");
const WAITFOR = require("waitfor");
const PARSE_LINK_HEADER = require("parse-link-header");
const OPENSSL = require("pio/lib/openssl");
const SSH = require("pio/lib/ssh");
const SPAWN = require("child_process").spawn;


var pioConfig = JSON.parse(FS.readFileSync(PATH.join(__dirname, "../.pio.json")));

require("io.pinf.server.www").for(module, __dirname, function(app, config, HELPERS) {

	config = config.config;

    const DB_NAME = "devcomp";



    function callGithub(userInfo, method, path, data, callback) {
        if (typeof data === "function" && typeof callback === "undefined") {
            callback = data;
            data = null;
        }
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
            json: data || true
        }, function (err, res, body) {
            if (err) return callback(err);
            if (res.statusCode === 403 || res.statusCode === 404 || res.statusCode === 401) {
                console.log("userInfo", userInfo);
                console.error("Got status '" + res.statusCode + "' for url '" + url + "'! This is likely due to NOT HAVING ACCESS to this API call because your OAUTH SCOPE is too narrow! See: https://developer.github.com/v3/oauth/#scopes", res.headers);
                var scope = null;
                if (/^\/repos\/([^\/]+)\/([^\/]+)\/hooks$/.test(path)) {
                    scope = "write:repo_hook";
                } else
                if (/^\/repos\/([^\/]+)\/([^\/]+)\/keys$/.test(path)) {
                    scope = "repo";
                } else
                if (res.statusCode === 401) {
                    scope = "";
                }
                if (typeof scope !== "undefined") {
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

        console.log("Ensure repository hook for:", org + "/" + repo);

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
                console.log("userInfo", userInfo);
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
            return r.tableEnsure(DB_NAME, "io_pinf_server_ci", "clones", function(err, clonesTable) {
                if (err) return callback(err);
    	        var waitfor = WAITFOR.parallel(callback);

    	        // Go through all deployed services and see if a repository is declared.
    	        // If repository is also found as being watched then we record it in
    	        // the database and register a github post-commit hook.

    	        // TODO: Use pinf-it based data here.
    			var deployedServices = JSON.parse(HELPERS.API.FS.readFileSync(PATH.join(__dirname, "../.pio.json"))).config["pio.services"].services;
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
    				        	waitfor(serviceId, m, function(serviceId, m, callback) {
                                    return callGithub(userInfo, "GET", "/repos/" + m[1] + "/" + m[2], function(err, res, repository) {
                                        if (err) return callback(err);
        								return repositoryTable.insert({
        			                		id: "github.com/" + m[1] + "/" + m[2],
                                            size: repository.size,
                                            private: repository.private,
                                            owner: "github.com/" + repository.owner.login
        			                	}, {
        			                        upsert: true
        			                    }).run(r.conn, function (err, result) {
        			                        if (err) return callback(err);
                                            return clonesTable.insert({
                                                id: "/opt/services/" + serviceId + "/clone",
                                                repository: "github.com/" + m[1] + "/" + m[2],
                                                branch: "master",
                                                path: "/opt/services/" + serviceId + "/clone"
                                            }, {
                                                upsert: true
                                            }).run(r.conn, function (err, result) {
                                                if (err) return callback(err);

            									return ensureHookForRepository(userInfo, r, m[1], m[2], callback);
                                            });
        			                    });
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
	    });
    }


    var Builder = function(userInfo, r) {
        var self = this;
        self._userInfo = userInfo;
        self._r = r;
        /*
        ensureBuilder__watcher = HELPERS.API.Q.denodeify(function (callback) {
            return r.tableEnsure(DB_NAME, "io_pinf_server_ci", "builds", {
                indexes: [
                    "updatedOn"
                ]
            }, function(err, buildsTable) {
                if (err) return callback(err);

                function listenForChanges(callback) {
// TODO: For some reason this throws: `TypeError: Object r.db("devcomp").table("io_pinf_server_ci__builds") has no method 'changes'`                    
                    return buildsTable.changes().run(r.conn, function(err, cursor) {
                        if (err) return callback(err);
                        if (cursor.hasNext()) {
                            return cursor.toArray(function(err, results) {
                                if (err) return callback(err);

console.log("CHANGES", results);


                             return callback(null);
                            });
                        }
                        return callback(null);
                    });
                }

                return listenForChanges(callback);
            });
        })();
        */

        function checkForRunningBuildTimeouts(callback) {
            console.log("checkForRunningBuildTimeouts()");
            return self._r.tableEnsure(DB_NAME, "io_pinf_server_ci", "builds", {
                indexes: [
                    "runningPing"
                ]
            }, function(err, buildsTable) {
                if (err) return callback(err);

                return buildsTable.filter(r.row("runningPing").lt(Date.now() - 15 * 1000)).run(self._r.conn, function (err, cursor) {
                    if (err) return callback(err);
//                    if (!cursor.hasNext()) {
//                        return callback(null);
//                    }
                    return cursor.toArray(function(err, result) {
                        if (err) return callback(err);

console.log("result", result);

                        return callback(null);
                    });
                });
            });
        }

        setInterval(function() {
            return checkForRunningBuildTimeouts(function (err) {
                if (err) {
                    console.error("WARN: Error checking running build timeouts:", err.stack);
                }
                return;
            });
        }, 15 * 1000);
    }

    Builder.prototype._ensureDeployKey = function (repository, callback) {
        var self = this;
        if (!self._ensureDeployKey__keyPath) {
            self._ensureDeployKey__keyPath = {};
        }
        console.log("Ensure deploy key for repository:", repository.id);
        // TODO: Path should be derived from config.
        var keyId = repository.id;
        var keyPath = PATH.join("/opt/data/io.pinf.server.ci/repositories/" + keyId.replace(/\//g, "~"), "deploy.rsa.key");

        if (self._ensureDeployKey__keyPath[keyId]) {
            return callback(null, self._ensureDeployKey__keyPath[keyId]);
        }

        // First see if we need a deploy key.
        if (repository.private === false) {
            // We have a public repo so we don't need a key to pull it.
            console.log("No key needed. Public repo.");
            return callback(null, (self._ensureDeployKey__keyPath[keyId] = false));
        }
        var m = repository.id.split("/");
        // We have a private repo so we need to make sure we have a deploy key.
        return callGithub(self._userInfo, "GET", "/repos/" + m[1] + "/" + m[2] + "/keys", function(err, res, keys) {
            if (err) return callback(err);

            function createKey(callback) {
                if (HELPERS.API.FS.existsSync(keyPath)) {
                    return callback(null, keyPath);
                }
                if (!HELPERS.API.FS.existsSync(PATH.dirname(keyPath))) {
                    HELPERS.API.FS.mkdirsSync(PATH.dirname(keyPath));
                }
                console.log("Generating deploy key at:", keyPath);
                return OPENSSL.generateKeys({
                    path: keyPath
                }).then(function() {
                    return SSH.exportPublicKeyFromPrivateKey(keyPath, keyPath + ".pub").then(function() {
                        return callback(null, keyPath);
                    });
                }).fail(callback);
            }

            function uploadKey(keyPath, callback) {
                return HELPERS.API.FS.readFile(keyPath + ".pub", "utf8", function (err, publicKey) {
                    if (err) return callback(err);
                    return callGithub(self._userInfo, "POST", "/repos/" + m[1] + "/" + m[2] + "/keys", {
                        title: "io.pinf.server.ci" + "@" + pioConfig.config.pio.hostname,
                        key: publicKey
                    }, function(err, res, result) {
                        if (err) return callback(err);
                        //console.log("upload result", result);
                        return callback(null);
                    });
                });
            }

            for (var i=0 ; i<keys.length ; i++) {
                if (keys[i].title === "io.pinf.server.ci" + "@" + pioConfig.config.pio.hostname) {
                    console.log("Found existing deploy key");
                    // TODO: Compare key and update if changed.
                    return callback(null, (self._ensureDeployKey__keyPath[keyId] = keyPath));
                }
            }

            return createKey(function(err, keyPath) {
                if (err) return callback(err);

                console.log("key created:", keyPath);

                return uploadKey(keyPath, function(err) {
                    if (err) return callback(err);

                    console.log("key uploaded:", keyPath);

                    return callback(null, (self._ensureDeployKey__keyPath[keyId] = keyPath));
                });
            });
        });
    }

    Builder.prototype._doBuild = function (id, callback) {
        var self = this;

        console.log("Trigger build for:", id);

        return self._r.tableEnsure(DB_NAME, "io_pinf_server_ci", "repositories", function(err, repositoryTable) {
            if (err) return callback(err);
            return self._r.tableEnsure(DB_NAME, "io_pinf_server_ci", "builds", function(err, buildsTable) {
                if (err) return callback(err);
                return self._r.tableEnsure(DB_NAME, "io_pinf_server_ci", "clones", function(err, clonesTable) {
                    if (err) return callback(err);

                    return buildsTable.get(id).run(self._r.conn, function (err, build) {
                        if (err) return callback(err);
                        return repositoryTable.get(build.repository).run(self._r.conn, function (err, repository) {
                            if (err) return callback(err);
                            return clonesTable.get(build.clone).run(self._r.conn, function (err, clone) {
                                if (err) return callback(err);

                                var runningPingInterval = null;

                                function startBuild(callback) {
                                    return buildsTable.get(build.id).update({
                                        "status": "running",
                                        "runningPing": Date.now(),
                                        "startTime": Date.now()
                                    }).run(self._r.conn, function (err, result) {
                                        if (err) return callback(err);
                                        runningPingInterval = setInterval(function() {
                                            return buildsTable.get(build.id).update({
                                                "runningPing": Date.now()
                                            }).run(self._r.conn, function (err, result) {
                                                if (err) {
                                                    // TODO: Should retry a few times before failing with error?
                                                    console.error("Error updating runningPing in db but ignoring!", err.stack);
                                                }
                                                // Nothing more to do.
                                                return;
                                            });
                                        }, 5 * 1000);
                                        return callback(null);
                                    });
                                }

                                function runBuild(_callback) {

                                    console.log("\n\n########## RUN BUILD ##########\n\n")

                                    var logPath = "/opt/data/io.pinf.server.ci/builds/build-" + Date.now() + "-" + build.id.replace(/\//g, "~") + ".log";
                                    console.log("Using log file:", logPath);
                                    if (!FS.existsSync(PATH.dirname(logPath))) {
                                        HELPERS.API.FS.mkdirsSync(PATH.dirname(logPath));
                                    }
                                    var logStream = FS.createWriteStream(logPath, {
                                        flags: "a",
                                        encoding: "utf8"
                                    });
                                    logStream.on("error", function (err) {
                                        return _callback(err);
                                    });
                                    logStream.on("finish", function () {
                                        return _callback();
                                    });
                                    var logging = null;
                                    function write(buffer) {
                                        return (logging = HELPERS.API.Q.ninvoke(logStream, "write", buffer, "utf8"));
                                    }
                                    function writeLine(line) {
                                        return (logging = HELPERS.API.Q.ninvoke(logStream, "write", line + "\n", "utf8"));
                                    }
                                    function callback (err) {
                                        if (!logging) {
                                            return logStream.end();
                                        }
                                        return logging.finally(function () {
                                            return logStream.end();
                                        });
                                    }

                                    return self._ensureDeployKey(repository, function(err, keyPath) {
                                        if (err) return callback(err);

                                        function fetchLatest(callback) {
                                            // TODO: Need better git repository sync logic here from `sm` command implementation.
                                            return HELPERS.API.FS.exists(clone.path, function (exists) {
                                                var cwd = PATH.dirname(clone.path);
                                                var args = [
                                                    "clone"
                                                ];
                                                var repositoryParts = repository.id.split("/");
                                                if (repository.private) {
                                                    args.push("git@github.com:" + repositoryParts[1] + "/" + repositoryParts[2] + ".git");
                                                } else {
                                                    args.push("https://github.com/" + repositoryParts[1] + "/" + repositoryParts[2] + ".git");
                                                }
                                                args.push(clone.path);
                                                if (exists) {
                                                    args = [
                                                        "pull",
                                                        "origin",
                                                        "master"
                                                    ];
                                                    cwd = clone.path;
                                                }

                                                var gitSshHelperPath = PATH.join(clone.path, "..", PATH.basename(clone.path) + ".git-ssh.sh");
                                                HELPERS.API.FS.outputFileSync(gitSshHelperPath, [
                                                    '#!/bin/sh',
                                                    'exec ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PasswordAuthentication=no -o IdentityFile=' + keyPath + ' "$@"'
                                                ].join("\n"));
                                                HELPERS.API.FS.chmodSync(gitSshHelperPath, 0755);

                                                console.log("Running command: git " + args.join(" ") + " (cwd: " + cwd + ")");
                                                logLine("----- Fetch latest START ----- ");
                                                logLine("Running command: git " + args.join(" ") + " (cwd: " + cwd + ")");
                                                var proc = SPAWN("git", args, {
                                                    cwd: cwd,
                                                    env: {
                                                        PATH: process.env.PATH,
                                                        GIT_SSH: gitSshHelperPath
                                                    }
                                                });
                                                proc.stdout.on('data', function (data) {
                                                    process.stdout.write(data);
                                                    write(data);
                                                });
                                                proc.stderr.on('data', function (data) {
                                                    process.stderr.write(data);
                                                    write(data);
                                                });
                                                proc.on('close', function (code) {
                                                    if (code !== 0) {
                                                        console.error("ERROR: Exited with code '" + code + "'");
                                                        return callback(new Error("Exited with code '" + code + "'"));
                                                    }
                                                    console.log("Finished running script!");
                                                    logLine("----- Fetch latest DONE ----- ");
                                                    return callback(null);
                                                });                                                
                                            });
                                            return callback(null);
                                        }

                                        function runIntegration(callback) {
                                            if (!FS.existsSync(PATH.join(clone.path, "package.json"))) {
                                                console.log("No package.json file found!");
                                                return callback(null);
                                            }
                                            var packageDescriptor = HELPERS.API.FS.readJsonSync(PATH.join(clone.path, "package.json"));
                                            if (
                                                !packageDescriptor ||
                                                !packageDescriptor.scripts ||
                                                !packageDescriptor.scripts.integrate
                                            ) {
                                                console.log("No 'scripts.integrate' property declared in package.json!");
                                                return callback(null);
                                            }
                                            var args = [
                                                "run-script",
                                                "integrate"
                                            ];
                                            console.log("Running command: npm " + args.join(" ") + " (cwd: " + clone.path + ")");
                                            logLine("----- Run integration START ----- ");
                                            logLine("Running command: npm " + args.join(" ") + " (cwd: " + clone.path + ")");
                                            var proc = SPAWN("npm", args, {
                                                cwd: clone.path,
                                                env: {
                                                    PATH: process.env.PATH
                                                }
                                            });
                                            proc.stdout.on('data', function (data) {
                                                process.stdout.write(data);
                                                write(data);
                                            });
                                            proc.stderr.on('data', function (data) {
                                                process.stderr.write(data);
                                                write(data);
                                            });
                                            proc.on('close', function (code) {
                                                if (code !== 0) {
                                                    console.error("ERROR: Exited with code '" + code + "'");
                                                    return callback(new Error("Exited with code '" + code + "'"));
                                                }
                                                console.log("Finished running integration script!");
                                                logLine("----- Run integration DONE ----- ");
                                                return callback(null);
                                            });                                              
                                        }

                                        return fetchLatest(function(err) {
                                            if (err) return callback(err);

                                            console.log("Running integration ...");
                                            return runIntegration(function (err) {
                                                if (err) return callback(err);

                                                console.log("Integration done!");

                                                return callback(null);
                                            });
                                        });
                                    });
                                }

                                function endBuild(buildErr, callback) {
                                    if (runningPingInterval) {
                                        clearInterval(runningPingInterval);
                                        runningPingInterval = null;
                                    }
                                    var changes = {
                                        "status": "success",
                                        "endTime": Date.now()
                                    };
                                    if (buildErr) {
                                        changes.status = "fail";
                                        console.error("Build error:", buildErr.stack);
                                    }                
                                    return buildsTable.get(build.id).update(changes).run(self._r.conn, function (err, result) {
                                        if (err) {
                                            // TODO: Should retry a few times before failing outright.
                                            console.error("Error setting build to done but ignoring!", err.stack);
                                        }
                                        return buildsTable.get(build.id).replace(self._r.row.without("runningPing")).run(self._r.conn, function (err, result) {
                                            if (err) {
                                                // TODO: Should retry a few times before failing outright.
                                                console.error("Error setting build to done but ignoring!", err.stack);
                                            }
                                            console.log("Build done", build.id, changes);
                                            return callback(buildErr);
                                        });
                                    });
                                }

                                return startBuild(function(err) {
                                    if (err) return callback(err);
                                    return runBuild(function(err) {
                                        return endBuild(err, callback);
                                    });
                                }); 
                            });
                        });
                    });
                });
            });
        });
    }
    Builder.prototype.trigger = function (callback) {
        var self = this;

        function findPending (callback) {
            return self._r.tableEnsure(DB_NAME, "io_pinf_server_ci", "builds", {
                indexes: [
                    "createdOn"
                ]
            }, function(err, buildsTable) {
                if (err) return callback(err);
                return buildsTable.orderBy({
                    index: self._r.desc("createdOn")
                })
                .filter(self._r.row("status").eq("pending"))
                .group("repository", "branch")
                .max("createdOn")
                .ungroup()
                .orderBy(self._r.asc("createdOn"))
                .run(self._r.conn, function(err, cursor) {
                    if (err) return callback(err);
//                    if (cursor.hasNext()) {
                        return cursor.toArray(function(err, results) {
                            if (err) return callback(err);
                            if (results.length === 0) {
                                return callback(null);
                            }
                            return self._doBuild(results.pop().reduction.id, callback);
                        });
//                    }
//                    return callback(null);
                });
            });
        }

        return findPending(callback);
    }


    var ensureBuilder__builder = null;
    function ensureBuilder(userInfo, r, callback) {
        if (!ensureBuilder__builder) {
            ensureBuilder__builder = new Builder(userInfo, r);
        }
        return callback(null, ensureBuilder__builder);
    }
    function triggerBuilds() {
        if (!ensureBuilder__builder) {
            console.log("Warning: Cannot trigger build as builder not initialized!");
            return;
        }
        console.log("Trigger builds ...");
        return ensureBuilder__builder.trigger(function (err) {
            if (err) {
                console.error("Error triggering builds", err.stack);
            }
            console.log("Finished triggering builds!");
            // Nothing more to do.
        });
    }


    app.post("/notify", function (req, res, next) {
        var r = res.r;
        var info = null;
        try {
            var payload = JSON.parse(req.body.payload);
            if (payload.ref) {
                var branchMatch = payload.ref.match(/^refs\/heads\/(.+)$/);
                if (branchMatch) {
                    info = {
                        id: "github.com/" + payload.repository.organization + "/" + payload.repository.name + "/build/" + payload.after,
                        repository: "github.com/" + payload.repository.organization + "/" + payload.repository.name,
                        commit: payload.after,
                        branch: branchMatch[1],
                        createdOn: (new Date(payload.head_commit.timestamp)).getTime(),
                        createdBy: "github.com/" + payload.pusher.name,
                        status: "pending"
                    };
                } else {
                    console.log("payload", JSON.stringify(payload, null, 4));
                    console.log("Warning: Ignoring event as branch '" + payload.ref + "' could not be matched!");
                }
            } else {
                console.log("payload", JSON.stringify(payload, null, 4));
                console.log("Warning: Ignoring event as branch '" + payload.ref + "' not set!");
            }
        } catch(err) {
            console.log("req.body.payload", req.body.payload);
            console.error("Error '" + err.message + "' parsing payload");
            return next(err);
        }

        if (info) {
            return r.tableEnsure(DB_NAME, "io_pinf_server_ci", "repositories", function(err, repositoryTable) {
                if (err) return next(err);
                return repositoryTable.get(info.repository).run(r.conn, function (err, result) {
                    if (err) return next(err);
                    if (!result) {
                        console.log("Ignore record new build as repository is not in database! Are we configured to watch it?", info);
                        return res.end();
                    }
                    console.log("Record new build for clones", info);
                    return r.tableEnsure(DB_NAME, "io_pinf_server_ci", "builds", function(err, buildsTable) {
                        if (err) return next(err);

                        // Now insert a build entry for each matching clone.
                        return res.r.tableEnsure(DB_NAME, "io_pinf_server_ci", "clones", function(err, clonesTable) {
                            if (err) return callback(err);

                            return clonesTable.filter(
                                r.row("repository").eq(info.repository).and(r.row("branch").eq(info.branch))
                            ).run(r.conn, function (err, cursor) {
                                if (err) return next(err);

//                                if (!cursor.hasNext()) {
//                                    console.log("Ignore record new build for repository '" + info.repository + "' as there are no clones for the branch '" + info.branch + "'!", info);
//                                    return res.end();
//                                }

                                return cursor.toArray(function(err, results) {
                                    if (err) return callback(err);

                                    if (results.length === 0) {
                                        console.log("Ignore record new build for repository '" + info.repository + "' as there are no clones for the branch '" + info.branch + "'!", info);
                                        return res.end();
                                    }

                                    var builds = results.map(function(clone) {
                                        var build = JSON.parse(JSON.stringify(info));
                                        build.clone = clone.id
                                        return build;
                                    });

                                    return buildsTable.insert(builds).run(r.conn, function (err, result) {
                                        if (err) return next(err);

                                        triggerBuilds();

                                        return res.end();
                                    }); 
                                }); 
                            });
                        });
                    });
                });
            });
        }

		return res.end();
    });


    app.get(/\/build\/list$/, function(req, res, next) {

        console.log("Build list triggered");

        function getRecords(callback) {
            return res.r.tableEnsure(DB_NAME, "io_pinf_server_ci", "builds", {
                indexes: [
                    "createdOn"
                ]
            }, function(err, table) {
                if (err) return callback(err);
                return table.orderBy({
                    index: res.r.desc("createdOn")
                })
                .limit(25)
                .run(res.r.conn, function(err, cursor) {
                    if (err) return callback(err);
//                    if (!cursor.hasNext()) {
//                        return callback(null, {});
//                    }
                    return cursor.toArray(function(err, results) {
                        if (err) return callback(err);
                        var records = {};
                        results.forEach(function (record) {
                            records[record.id] = record;
                        });
                        return callback(null, records);
                    });
                });
            });
        }
        return getRecords(function(err, records) {
            if (err) return next(err);
            var payload = JSON.stringify(records, null, 4);
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
                "Cache-Control": "max-age=5"  // seconds
            });
            return res.end(payload);
        });
    });


    app.get(/\/clone\/list$/, function(req, res, next) {

        console.log("Clone list triggered");

        function getRecords(callback) {
            return res.r.tableEnsure(DB_NAME, "io_pinf_server_ci", "clones", function(err, clonesTable) {
                if (err) return callback(err);
                return res.r.tableEnsure(DB_NAME, "io_pinf_server_ci", "builds", {
                    indexes: [
                        "status"
                    ]
                }, function(err, buildsTable) {
                    if (err) return callback(err);
                    return clonesTable.orderBy(res.r.asc("path")).run(res.r.conn, function(err, clonesCursor) {
                        if (err) return callback(err);
//                        if (!clonesCursor.hasNext()) {
//                            return callback(null, {});
//                        }
                        return clonesCursor.toArray(function(err, clonesResults) {
                            if (err) return callback(err);

                            function getLatestBuilds(callback) {
                                return buildsTable.orderBy({
                                    index: res.r.desc("createdOn")
                                })
                                .group("repository", "branch")
                                .max("createdOn")
                                .ungroup()
                                .map(res.r.row("reduction"))
                                .run(res.r.conn, function(err, buildsCursor) {
                                    if (err) return callback(err);
//                                    if (!buildsCursor.hasNext()) {
//                                        return callback(null, {});
//                                    }
                                    return buildsCursor.toArray(function(err, results) {
                                        var builds = {};
                                        results.forEach(function(result) {
                                            builds[result.clone] = result;
                                        });
                                        return callback(null, builds);
                                    });
                                });
                            }

                            return getLatestBuilds(function(err, builds) {
                                if (err) return callback(err);
                                var records = {};
                                clonesResults.forEach(function (record) {
                                    records[record.id] = record;
                                    if (builds[record.id]) {
                                        for (var name in builds[record.id]) {
                                            if (typeof records[record.id][name] === "undefined") {
                                                records[record.id][name] = builds[record.id][name];
                                            }
                                        }
                                    }
                                });
                                return callback(null, records);
                            });
                        });
                    });
                });
            });
        }
        return getRecords(function(err, records) {
            if (err) return next(err);
            var payload = JSON.stringify(records, null, 4);
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
                "Cache-Control": "max-age=5"  // seconds
            });
            return res.end(payload);
        });
    });


    var credentialsEnsured = false;

    app.get(/\/ensure\/credentials$/, function(req, res, next) {

        console.log("Ensure credentials triggered");

        function respond (payload) {
            payload = JSON.stringify(payload, null, 4);
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
                "Cache-Control": "max-age=15"  // seconds
            });
            return res.end(payload);
        }

        if (credentialsEnsured) {
            return respond({
                "$status": 200
            });
        }

        if (!res.view || !res.view.authorized) {
            console.log("No user authorized!");
            return respond({
                "$status": 403,
                "$statusReason": "No user authorized!"
            });
        }
        if (!res.view.authorized.github) {
            console.log("No github user authorized!");
            return respond({
                "$status": 403,
                "$statusReason": "No github user authorized!"
            });
        }

        console.log("res.view.authorized", JSON.stringify(res.view.authorized, null, 4));
        if (
            res.view.authorized.github.scope.indexOf("write:repo_hook") === -1 ||
            res.view.authorized.github.scope.indexOf("repo") === -1
        ) {
            var scope = "write:repo_hook,repo";
/*
NOTE: This works if we want to redirect the response and upgrade the scope.
            console.error("User needs more privileges to activate this service. See: https://developer.github.com/v3/oauth/#scopes");
            console.log("We are going to start a new oauth session with the new require scope added ...");
            var err = new Error("Insufficient privileges. Should start new session with added scope: " + scope);
            err.code = 403;
            err.requestScope = scope;
            return next(err);
*/
            console.log("Insufficient scope. Requesting more scope: " + scope);
            return respond({
                "$status": 403,
                "$statusReason": "Insufficient scope",
                "requestScope": scope
            });
        }

        console.log("Hook repositories with access token from user:", res.view.authorized.github.username);

        return hookRepositories(res.view.authorized.github, res.r, function (err) {
            if (err) {                
                console.error("Error hooking repositories", err.stack);
                return respond({
                    "$status": 500,
                    "$statusReason": "Error hooking repositories: " + err.stack
                });
            }
            console.log("Repository hooking done");

            console.log("Start builder ...");
            return ensureBuilder(res.view.authorized.github, res.r, function (err) {
                if (err) {
                    return respond({
                        "$status": 500,
                        "$statusReason": "Error starting builder: " + err.stack
                    });
                }
                console.log("Builder started!");

                triggerBuilds();

                credentialsEnsured = true;

                return respond({
                    "$status": 200
                });
            });
        });
    });

});
