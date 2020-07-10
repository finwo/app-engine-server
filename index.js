require('dotenv').config();

const argv         = require('minimist')(process.argv.slice(2));
const fs           = require('fs');
const http         = require('http');
const mime         = require('mime-types');
const path         = require('path');
const spawn        = require('child_process').spawn;
const url          = require('url');
const yaml         = require('yaml');
const HeaderParser = require('header-stack').Parser;
const Stream       = require('stream').Stream;

// Basics from args
const cgibin     = argv.cgi || process.env.CGI || null;
const port       = parseInt(argv.port) || parseInt(process.env.PORT) || 8080;
const configFile = path.resolve(argv.config || process.env.CONFIG || 'app.yaml');
const approot    = path.resolve(argv.approot || process.env.APPROOT || path.dirname(configFile));

// Handle --help
if (argv.help || argv.h) {
  process.stdout.write(`Usage: app-engine-server [options]\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --help -h         Show this usage\n`);
  process.stdout.write(`  --port <port>     Set port to host on (current: ${port})\n`);
  process.stdout.write(`  --config <path>   Select app.yaml file to use\n`);
  process.stdout.write(`  --approot <path>  Set custom approot, defaults to config's directory\n`);
  process.exit(0);
}

// Fetch the actual config
const configStr = fs.readFileSync(configFile, 'utf8');
const config    = yaml.parse(configStr);

// CGI runner
function cgi({req, res, cgibin, script = null} = {}) {
  if (!req.hasOwnProperty("uri")) { req.uri = url.parse(req.url); }
  const serverAddress = (req.headers.host || ('devserver:'+port)).split(':');

  // Basic
  const opt = {env:process.env};
  opt.env.REDIRECT_STATUS   = 200;
  opt.env.SERVER_SOFTWARE   = 'Node/'+process.version;
  opt.env.SERVER_PROTOCOL   = 'HTTP/1.1';
  opt.env.GATEWAY_INTERFACE = 'CGI/1.1';
  opt.env.SCRIPT_FILENAME   = script;
  opt.env.SCRIPT_NAME       = script;
  opt.env.SERVER_NAME       = serverAddress[0] || 'devserver';
  opt.env.SERVER_PORT       = serverAddress[1] || port;
  opt.env.PATH_INFO         = req.uri.pathname;
  opt.env.REQUEST_METHOD    = req.method;
  opt.env.REQUEST_URI       = req.url;
  opt.env.QUERY_STRING      = req.uri.query || '';
  opt.env.REMOTE_ADDR       = req.connection.remoteAddress;
  opt.env.REMOTE_PORT       = req.connection.remotePort;
  opt.env.QUERY_STRING      = req.uri.query || '';

  // Headers
  Object.keys(req.headers).forEach(key => {
    const cgikey = 'HTTP_' + key.toUpperCase().replace(/-/g,'_');;
    opt.env[cgikey] = req.headers[key];
  });

  // Special headers
  if ('content-length' in req.headers) {
    opt.env.CONTENT_LENGTH = req.headers['content-length'];
  }
  if ('content-type' in req.headers) {
    opt.env.CONTENT_TYPE = req.headers['content-type'];
  }
  if ('authorization' in req.headers) {
    var auth = req.headers.authorization.split(' ');
    opt.env.AUTH_TYPE = auth[0];
  }

  // Setup  parser
  const headerParser = new HeaderParser(new Stream(), {
    emitFirstLine        : false,
    strictCRLF           : false,
    strictSpaceAfterColor: false,
    allowFoldedHeaders   : false,
  });
  headerParser.on('headers', (headers, leftovers) => {
    headers.forEach(header => {
      switch(header.key.toLowerCase()) {
        case 'status':
          const tokens = header.value.split(' ');
          res.statusCode    = tokens.shift();
          res.statusMessage = tokens.join(' ');
          break;
        default:
          res.setHeader(header.key, header.value);
          break;
      }
    });
    if (leftovers) {
      res.write(leftovers);
    }
    res.end();
  });

  // Start the child
  const cgiSpawn = spawn(cgibin, [], opt);
  req.pipe(cgiSpawn.stdin);
  cgiSpawn.stderr.pipe(process.stdout);

  // Redirect from child -> parser
  let bufferedData = Buffer.alloc(0);
  cgiSpawn.stdout.on('data', data => {
    bufferedData = Buffer.concat([bufferedData, data]);
  });
  cgiSpawn.stdout.on('end', () => {
    headerParser.stream.emit('data', bufferedData);
  });

  return;
}

// Prepare handler list
const handlers = [];

// Compile handlers
config.handlers.forEach(handler => {
  const reg = new RegExp(handler.url.split('/').join('\\/'));
  handlers.push((req, res, next) => {
    const matches = req.url.match(reg);
    if (!matches) return next();

    // CGI handler
    if (handler.script) {
      let script = handler.script;
      matches.forEach((value, index) => {
        script = script.split('\\'+index).join(value);
      });

      // Call CGI script
      script = path.resolve(approot,script);
      return cgi({req, res, cgibin, script});
    }

    // Static handler
    if (handler.static_files) {
      let static_file = handler.static_files;
      matches.forEach((value, index) => {
        static_file = static_file.split('\\'+index).join(value);
      });

      static_file = path.resolve(approot,static_file);
      fs.readFile(static_file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.statusCode    = 200;
        res.statusMessage = 'OK';
        res.setHeader('Content-Type', mime.lookup(static_file));
        res.end(data);
      });
      return;
    }

    // This handler is not the one
    next();
  });
});

// 404 handler
handlers.push((req, res) => {
  res.writeHead(404);
  res.end('Not Found');
});

// Build http server
let server = http.createServer((req, res) => {
  const cq = handlers.slice();
  (function run() {
    const fn = cq.shift();
    if (!fn) return;
    fn(req, res, run);
  })();
});

// Start listening
server.listen(port, '0.0.0.0', err => {
  if (err) throw err;
  console.log(`listening on http://0.0.0.0:${port}`);
});
