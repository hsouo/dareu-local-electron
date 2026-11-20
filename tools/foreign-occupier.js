// 占位用的“外来”HTTP 服务：不是本项目（/api/state 返回 404），用来验证端口自动顺延
const http = require('http');
const port = Number(process.env.FOREIGN_PORT || 8082);
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('foreign-occupier'); });
srv.listen(port, '127.0.0.1', () => console.log('foreign listening ' + port + ' pid=' + process.pid));
process.on('SIGINT', () => { srv.close(() => process.exit(0)); });
