#!/usr/bin/env node

// This script starts a server that can be used in simulation mode
// to debug the pvd.json retrieval and monitoring feature

const Net = require("net");
const http = require('http');
const os = require("os");
const fs = require('fs');
const EventEmitter = require('events').EventEmitter;

var WebSocketServer = require('websocket').server;

var pvdEmitter = new EventEmitter();

var Verbose = false;

var AllPvd = {};
var CurrentListPvD = [];

function dlog(s) {
	if (Verbose) {
		console.log(s);
	}
}

function GetJson(s) {
	try {
		return(JSON.parse(s));
	} catch (e) {
		dlog("GetJson(" + s + ") : invalid JSON (" + e + ")")
	};
	return(null);
}

function ComplainConnection(Port, err) {
	dlog("Can not connect to pvdid-daemon on port " +
	     Port +
	     " (" + err.message + ")");
}

// NewPvD : registers a new pvd. If already existing, does nothing
function NewPvD(pvdId) {
	if (AllPvd[pvdId] == null) {
		AllPvd[pvdId] = { pvd : pvdId, attributes : {} };
	}
}

// DelPvD : unregisters a pvd. This, for now, cancels any pending timer and
// set its entry to null
function DelPvD(pvdId) {
	AllPvd[pvdId] = null;
}

// UpdateAttributes : update the internal attributes structure for a given
// pvdId and notifies all websocket connections. This function is called when
// the attributes for the PvD have been received
function UpdateAttribute(sock, pvdId, attributes) {
	dlog("UpdateAttribute : pvdId = " + pvdId + ", attributes = " + attributes);

	if (AllPvd[pvdId] != null) {
		if ((J = GetJson(attributes)) != null) {
			AllPvd[pvdId].attributes = J;

			pvdEmitter.emit("pvdAttributes", {
				pvd : pvdId,
				pvdAttributes : J
			});
		}
	}
}

// HandleMultiLine : a multi-line message has been fully read
// Parse the message and handle it
function HandleMultiLine(sock, msg) {
	dlog("HandleMultiLine : msg = " + msg);

	if ((r = msg.match(/PVDID_ATTRIBUTES +([^ \n]+)\n([\s\S]+)/i)) != null) {
		UpdateAttribute(sock, r[1], r[2]);
		return;
	}
	return;
}

// HandleOneLine : one line message handling. The trailing
// \n must have been removed
var multiLines = false;
var fullMsg = "";

function HandleOneLine(sock, msg) {
	dlog("Handling one line : " + msg + " (multiLines = " + multiLines + ")");

	// We check the beginning of a multi-lines section
	// before anything else, to reset the buffer in case
	// a previous multi-lines was improperly closed
	if (msg == "PVDID_BEGIN_MULTILINE") {
		multiLines = true;
		fullMsg = "";
		return;
	}

	// End of a multi-lines section ?
	if (msg == "PVDID_END_MULTILINE") {
		HandleMultiLine(sock, fullMsg);
		multiLines  = false;
		return;
	}

	// Are we in a mult-line section ?
	if (multiLines) {
		fullMsg += msg + "\n";
		return;
	}

	// Single line messages
	if ((r = msg.match(/PVDID_LIST +(.*)/i)) != null) {
		if ((newListPvD = r[1].match(/[^ ]+/g)) == null) {
			return;
		}

		newListPvD.forEach(function(pvdId) {
			if (AllPvd[pvdId] == null) {
				// New PvD => retrieve its attributes
				NewPvD(pvdId);
				sock.write("PVDID_GET_ATTRIBUTES " + pvdId + "\n");
			}
		});
		// We compare the stringified version of the arrays
		// (it does not really matter if we are detecting differences
		// for reordered pvds even if they are the same : in this case
		// we will notify more often than strictly necessary, but this
		// will not hurt)
		if (JSON.stringify(CurrentListPvD) !== JSON.stringify(newListPvD)) {
			pvdEmitter.emit("pvdList", newListPvD);

			CurrentListPvD = newListPvD;
		}
		dlog("New pvd list : " + JSON.stringify(AllPvd, null, 4));
		return;
	}

	if (msg.match(/PVDID_NEW_PVDID.*/i) != null) {
		// Ignore them (we prefer using PVDID_LIST instead)
		return;
	}

	if ((r = msg.match(/PVDID_DEL_PVDID +([^ ]+)/i)) != null) {
		// We must stop monitoring this PvD and unregister it
		DelPvD(r[1]);
		return;
	}

	if ((r = msg.match(/PVDID_ATTRIBUTES +([^ ]+) +(.+)/i)) != null) {
		UpdateAttribute(sock, r[1], r[2]);
		return;
	}
	return;
}

// Regular connection related functions. The regular connection will be used to send
// queries (PvD list and attributes) and to receive replies/notifications
function regularSockInit(sock) {
	sock.write("PVDID_GET_LIST\n");
	sock.write("PVDID_SUBSCRIBE_NOTIFICATIONS\n");
	sock.write("PVDID_SUBSCRIBE *\n");
}

var regularSock = null;

function regularConnection(Port) {
	// Perform the initial connection, and automatic reconnection
	// in case we lose connection with it
	if (regularSock == null) {
		regularSock = Net.connect({ host : "0.0.0.0", port : Port });
		regularSock.on("connect", function() {
			regularSockInit(regularSock);
			console.log("Regular connection established with pvdid-daemon");
		});
		regularSock.on("error", function(err) {
			ComplainConnection(Port, err);
			regularSock = null;
		});
		regularSock.on("data", function(d) {
			d.toString().split("\n").forEach(function(oneLine) {
				HandleOneLine(regularSock, oneLine);
			});
		});
	}
	else {
		regularSock.write("\n");	// to trigger a connection error
	}
	setTimeout(regularConnection, 1000, Port);
}

// Options parsing
var Help = false;
var PortNeeded = false;
var HttpPort = 8080;

process.argv.forEach(function(arg) {
	if (arg == "-h" || arg == "--help") {
		Help = true;
	} else
	if (arg == "-v" || arg == "--verbose") {
		Verbose = true;
	} else
	if (arg == "-p" || arg == "--port") {
		PortNeeded = true;
	} else
	if (PortNeeded) {
		HttpPort = arg;
		PortNeeded = false;
	}
});

if (Help) {
	console.log("pvdid-monitor [-h|--help] <option>*");
	console.log("with option :");
	console.log("\t-v|--verbose : outputs extra logs during operation");
	console.log("\t-p|--port #  : http port to listen on (default 8080)");
	process.exit(0);
}

var Port = parseInt(process.env["PVDID_PORT"]) || 10101;

console.log("Listening on http port " + HttpPort + ", pvdd port " + Port);
console.log("Hostname : " + os.hostname());

regularConnection(Port);

// =================================================
// Server part : it provides web clients a regular
// http as well as a websocket connection to retrieve
// a static page (via http) and live notifications
// via the websocket (for PvD related informations)

var server = http.createServer(function(req, res) {
	var page = fs.readFileSync(__dirname + "/pvdClient.html");
	res.writeHead(200);
	res.end(page);
});

server.listen(HttpPort);

var ws = new WebSocketServer({ httpServer : server, autoAcceptConnections: true });

function Send2Client(conn, o) {
	conn.sendUTF(JSON.stringify(o));
}

ws.on('connect', function(conn) {
	console.log("New websocket client");

	Send2Client(conn, {
		what : "hostname",
		payload : { hostname : os.hostname() }
	});

	conn.on("message", function(m) {
		if (m.type == "utf8") {
			HandleMessage(conn, m.utf8Data);
		}
	});
	conn.on("close", function() {
		console.log("Connection closed");
	});

	pvdEmitter.on("pvdList", function(ev) {
		Send2Client(conn, {
			what : "pvdList",
			payload : { pvdList : ev }
		});
	});
	pvdEmitter.on("pvdAttributes", function(ev) {
		Send2Client(conn, {
			what : "pvdAttributes",
			payload : {
				pvd : ev.pvd,
				pvdAttributes : ev.pvdAttributes
			}
		});
	});
	pvdEmitter.on("hostDate", function(ev) {
		Send2Client(conn, {
			what : "hostDate",
			payload : { hostDate : ev }
		});
	});
});

function HandleMessage(conn, m) {
	if (m == "PVDID_GET_LIST") {
		conn.sendUTF(JSON.stringify({
			what : "pvdList",
			payload : {
				pvdList : CurrentListPvD
			}
		}));
	} else
	if (m == "PVDID_GET_ATTRIBUTES") {
		for (var key in AllPvd) {
			if ((p = AllPvd[key]) != null) {
				conn.sendUTF(JSON.stringify({
					what : "pvdAttributes",
					payload : {
						pvd : p.pvd,
						pvdAttributes : p.attributes
					}
				}));
			}
		};
	}
}

function SendDate() {
	var now = new Date(Date.now());
	pvdEmitter.emit("hostDate", now.toISOString());
	setTimeout(SendDate, 5000);
}

SendDate();
