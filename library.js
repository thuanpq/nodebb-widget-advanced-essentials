(function(module) {
	"use strict";

	var async = module.parent.require('async'),
		nconf = module.parent.require('nconf'),
		fs = require('fs'),
		path = require('path'),
		db = module.parent.require('./database'),
		categories = module.parent.require('./categories'),
		user = module.parent.require('./user'),
		plugins = module.parent.require('./plugins'),
		topics = module.parent.require('./topics'),
		posts = module.parent.require('./posts'),
		groups = module.parent.require('./groups'),
		translator = module.parent.require('../public/src/modules/translator'),
		templates = module.parent.require('templates.js'),
		websockets = module.parent.require('./socket.io'),
		app;


	var Widget = {
		templates: {}
	};

	Widget.init = function(params, callback) {
		app = params.app;

		var templatesToLoad = [
			"widgets/friends.tpl", "admin/myfriends.tpl"
		];

		function loadTemplate(template, next) {
			fs.readFile(path.resolve(__dirname, './public/templates/' + template), function (err, data) {
				if (err) {
					console.log(err.message);
					return next(err);
				}
				Widget.templates[template] = data.toString();
				next(null);
			});
		}

		async.each(templatesToLoad, loadTemplate);

		callback();
	};

	Widget.renderHTMLWidget = function(widget, callback) {
		callback(null, widget.data.html);
	};

	Widget.renderTextWidget = function(widget, callback) {
		var parseAsPost = !!widget.data.parseAsPost,
			text = widget.data.text;

		if (parseAsPost) {
			plugins.fireHook('filter:parse.raw', text, callback);
		} else {
			callback(null, text.replace(/\r\n/g, "<br />"));
		}
	};

	Widget.renderRecentViewWidget = function(widget, callback) {
		topics.getLatestTopics(widget.uid, 0, 19, 'month', function (err, data) {
			if(err) {
				return callback(err);
			}

			app.render('recent', data, function(err, html) {
				html = html.replace(/<ol[\s\S]*?<br \/>/, '').replace('<br>', '');

				translator.translate(html, function(translatedHTML) {
					callback(err, translatedHTML);
				});
			});
		});
	};

	Widget.renderActiveUsersWidget = function(widget, callback) {
		function getUserData(err, uids) {
			if (err) {
				return callback(err);
			}

			uids = uids.slice(0, count);

			user.getMultipleUserFields(uids, ['uid', 'username', 'userslug', 'picture'], function(err, users) {
				if (err) {
					return callback(err);
				}

				html = templates.parse(html, {
					active_users: users,
					relative_path: nconf.get('relative_path')
				});

				callback(err, html);
			});
		}
		var count = Math.max(1, widget.data.numUsers || 24);
		var html = Widget.templates['widgets/activeusers.tpl'], cidOrtid;
		var match;
		if (widget.data.cid) {
			cidOrtid = widget.data.cid;
			categories.getActiveUsers(cidOrtid, getUserData);
		} else if (widget.area.url.startsWith('topic')) {
			match = widget.area.url.match('topic/([0-9]+)');
			cidOrtid = (match && match.length > 1) ? match[1] : 1;
			topics.getUids(cidOrtid, getUserData);
		} else if (widget.area.url === '') {
			posts.getRecentPosterUids(0, count - 1, getUserData);
		} else {
			match = widget.area.url.match('[0-9]+');
			cidOrtid = match ? match[0] : 1;
			categories.getActiveUsers(cidOrtid, getUserData);
		}
	};

    Widget.renderLatestUsersWidget = function(widget, callback) {
        var count = Math.max(1, widget.data.numUsers || 24);
        user.getUsersFromSet('users:joindate', widget.uid, 0, count - 1, function(err, users) {
            if (err) {
                return callback(err);
            }
            app.render('widgets/latestusers', {users: users}, callback);
        });
    };

    Widget.renderMyFriendsWidget = function(widget, callback) {
        var count = Math.max(1, widget.data.numUsers || 24);
        user.getUsersFromSet('users:joindate', widget.uid, 0, count - 1, function(err, users) {
            if (err) {
                return callback(err);
            }
            app.render('widgets/friends', {users: users}, callback);
        });
    };


	Widget.renderModeratorsWidget = function(widget, callback) {
		var html = Widget.templates['widgets/moderators.tpl'], cid;

		if (widget.data.cid) {
			cid = widget.data.cid;
		} else {
			var match = widget.area.url.match('[0-9]+');
			cid = match ? match[0] : 1;
		}

		categories.getModerators(cid, function(err, moderators) {
			html = templates.parse(html, {moderators: moderators});

			callback(err, html);
		});
	};

	Widget.renderForumStatsWidget = function(widget, callback) {
		async.parallel({
			global: function(next) {
				db.getObjectFields('global', ['topicCount', 'postCount', 'userCount'], next);
			},
			onlineCount: function(next) {
				var now = Date.now();
				db.sortedSetCount('users:online', now - 300000, now, next);
			}
		}, function(err, results) {
			if (err) {
				return callback(err);
			}

			var stats = {
				topics: results.global.topicCount ? results.global.topicCount : 0,
				posts: results.global.postCount ? results.global.postCount : 0,
				users: results.global.userCount ? results.global.userCount : 0,
				online: results.onlineCount + websockets.getOnlineAnonCount(),
				statsClass: widget.data.statsClass
			};
			app.render('widgets/forumstats', stats, function(err, html) {
				translator.translate(html, function(translatedHTML) {
					callback(err, translatedHTML);
				});
			});
		});
	};

	Widget.renderRecentPostsWidget = function(widget, callback) {
		function done(err, posts) {
			if (err) {
				return callback(err);
			}
			app.render('widgets/recentposts', {posts: posts, numPosts: numPosts, cid: cid}, function(err, html) {
				translator.translate(html, function(translatedHTML) {
					callback(err, translatedHTML);
				});
			});
		}
		var cid = widget.data.cid;
		if (!parseInt(cid, 10)) {
			var match = widget.area.url.match('category/([0-9]+)');
			cid = (match && match.length > 1) ? match[1] : null;
		}
		var numPosts = widget.data.numPosts || 4;
		if (cid) {
			categories.getRecentReplies(cid, widget.uid, numPosts, done);
		} else {
			posts.getRecentPosts(widget.uid, 0, Math.max(0, numPosts - 1), 'alltime', done);
		}
	};

	Widget.renderRecentTopicsWidget = function(widget, callback) {
		var numTopics = (widget.data.numTopics || 8) - 1;

		topics.getTopicsFromSet('topics:recent', widget.uid, 0, Math.max(0, numTopics), function(err, data) {
			if (err) {
				return callback(err);
			}

			app.render('widgets/recenttopics', {
				topics: data.topics,
				numTopics: numTopics,
				relative_path: nconf.get('relative_path')
			}, function(err, html) {
				translator.translate(html, function(translatedHTML) {
					callback(err, translatedHTML);
				});
			});
		});
	};

	Widget.renderCategories = function(widget, callback) {
		var html = Widget.templates['widgets/categories.tpl'];

		categories.getCategoriesByPrivilege('cid:0:children', widget.uid, 'find', function(err, data) {
			html = templates.parse(html, {
				categories: data,
				relative_path: nconf.get('relative_path')
			});

			callback(err, html);
		});
	};

	Widget.renderPopularTags = function(widget, callback) {
		var html = Widget.templates['widgets/populartags.tpl'];
		var numTags = widget.data.numTags || 8;
		topics.getTags(0, numTags - 1, function(err, tags) {
			if (err) {
				return callback(err);
			}

			html = templates.parse(html, {tags: tags});

			callback(err, html);
		});
	};

	Widget.renderPopularTopics = function(widget, callback) {
		var numTopics = widget.data.numTopics || 8;
		topics.getPopular(widget.data.duration || 'alltime', widget.uid, numTopics, function(err, topics) {
			if (err) {
				return callback(err);
			}

			app.render('widgets/populartopics', {
				topics: topics,
				numTopics: numTopics,
				relative_path: nconf.get('relative_path')
			}, function(err, html) {
				translator.translate(html, function(translatedHTML) {
					callback(err, translatedHTML);
				});
			});
		});
	};

	Widget.renderMyGroups = function(widget, callback) {
		var uid = widget.uid;
		var numGroups = parseInt(widget.data.numGroups, 10) || 9;
		groups.getUserGroups([uid], function(err, groupsData) {
			if (err) {
				return callback(err);
			}
			var userGroupData = groupsData.length ? groupsData[0] : [];
			userGroupData = userGroupData.slice(0, numGroups);
			app.render('widgets/groups', {
				groups: userGroupData,
				relative_path: nconf.get('relative_path')
			}, function(err, html) {
				translator.translate(html, function(translatedHTML) {
					callback(err, translatedHTML);
				});
			});
		});
	};

	Widget.renderNewGroups = function(widget, callback) {
		var numGroups = parseInt(widget.data.numGroups, 10) || 8;
		async.waterfall([
			function(next) {
				db.getSortedSetRevRange('groups:visible:createtime', 0, numGroups - 1, next);
			},
			function(groupNames, next) {
				groups.getGroupsData(groupNames, next);
			},
			function(groupsData, next) {
				groupsData = groupsData.filter(Boolean);
				groupsData.forEach(groups.escapeGroupData);

				app.render('widgets/groups', {groups: groupsData}, function(err, html) {
					translator.translate(html, function(translatedHTML) {
						next(err, translatedHTML);
					});
				});
			}
		], callback);
	};

	Widget.renderSuggestedTopics = function(widget, callback) {

		var numTopics = (widget.data.numTopics || 8) - 1;
		var tidMatch = widget.area.url.match('topic/([0-9]+)');
		var cidMatch = widget.area.url.match('category/([0-9]+)');

		if (tidMatch) {
			var tid = tidMatch.length > 1 ? tidMatch[1] : 1;
			topics.getSuggestedTopics(tid, widget.uid, 0, numTopics, function(err, topics) {
				if (err) {
					return callback(err);
				}
				app.render('widgets/suggestedtopics', {
					topics: topics,
					relative_path: nconf.get('relative_path')
				}, callback);
			});
		} else if (cidMatch) {
			var cid = cidMatch.length > 1 ? cidMatch[1] : 1;
			categories.getCategoryTopics({
				cid: cid,
				uid: widget.uid,
				set: 'cid:' + cid + ':tids',
				reverse: false,
				start: 0,
				stop: numTopics
			}, function(err, data) {
				if (err) {
					return callback(err);
				}
				app.render('widgets/suggestedtopics', {
					topics: data.topics,
					relative_path: nconf.get('relative_path')
				}, callback);
			});
		} else {
			Widget.renderRecentTopicsWidget(widget, callback);
		}
	};

	Widget.defineWidgets = function(widgets, callback) {
		widgets = widgets.concat([
            {
                widget:"myfriends",
                name:"My Friends",
                description: "List of your friends",
                content: Widget.templates['admin/myfriends.tpl']
            }
		]);

		callback(null, widgets);
	};


	module.exports = Widget;
}(module));