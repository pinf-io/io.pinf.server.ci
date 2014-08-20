
define(function() {

	return function() {
		var self = this;

		return self.hook(
			{
				"htm": "./" + self.widget.id + ".htm"
			},
			{
				"builds": "http://io-pinf-server-ci." + window.API.config.hostname + ":8013/build/list",
			},
			[
				{
					resources: [ "htm" ],
					streams: [ "builds"],
					handler: function(_htm, _builds) {
						_builds.on("data", function(records) {

							for (var id in records) {
								var record = records[id];

								record.$display = JSON.parse(JSON.stringify(record));

								record.$display.age = Math.floor((Date.now()-record.createdOn)/1000/60) + " min";

								var duration = "";
								if (records[id].endTime) {
									duration = Math.ceil((records[id].endTime - records[id].startTime)/1000/60) + " min";
								} else
								if (records[id].startTime) {
									duration = Math.ceil((Date.now() - records[id].startTime)/1000/60) + " min";
								}
								record.$display.duration = duration;

								record.$style = {
									row: ""
								};
								if (record.status === "success") {
									record.$style.row = "success";
									record.$display.status = '<span class="label label-success">Success</span>';
								} else
								if (record.status === "pending") {
									record.$style.row = "warning";
									record.$display.status = '<span class="label label-warning">Pending</span>';
								} else
								if (record.status === "fail") {
									record.$style.row = "danger";
									record.$display.status = '<span class="label label-danger">Fail</span>';
								} else
								if (record.status === "timeout") {
									record.$style.row = "danger";
									record.$display.status = '<span class="label label-danger">Timeout</span>';
								}
							}

							return self.setHTM(_htm, {
								records: records
							}).then(function(tag) {
								$("TR", tag).click(function(event) {
									var row = null;
									while ((row = ((row && row.parent()) || $(event.target)))) {
										if (row.length === 0) break;
										if (row[0].nodeName === "BUTTON") return;
										if (row.attr("record-id")) break;
									}
									window.API.helpers.showLogDialog(records[row.attr("record-id")].logPath, {
										updateUrlHash: false
									});
									return false;
								});
							});
						});

						return self.API.Q.resolve();
					}
				}
			]
		);
	};
});
