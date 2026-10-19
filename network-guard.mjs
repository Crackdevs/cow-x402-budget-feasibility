// Loaded before tests and SDK imports. All test I/O must use in-process fakeFetch.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => { throw new Error('EXTERNAL_NETWORK_DISABLED_FOR_TEST'); };
globalThis.fetch = deny;
net.Socket.prototype.connect = deny;
net.connect = net.createConnection = deny;
tls.connect = deny;
http.request = http.get = https.request = https.get = deny;
dns.lookup = dns.resolve = deny;
dns.promises.lookup = dns.promises.resolve = deny;
dgram.createSocket = deny;
syncBuiltinESMExports();
