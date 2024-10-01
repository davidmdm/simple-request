import http = require('http');
import https = require('https');
import tls = require('tls');

import util = require('util');
import { URL } from 'url';
import { Readable, PassThrough } from 'stream';

import qs = require('qs');
import querystring = require('querystring');
import FormData = require('form-data');

import { Connection } from './connection';
import { Options, RequestOptions, sanitizeOpts } from './options';

const version = require('../package.json').version;

const defaultUserAgent = util.format(
  'Beggar/%s (Node.js %s; %s %s)',
  version,
  process.version,
  process.platform,
  process.arch
);

const httpLib = (protocol: string) => {
  switch (protocol) {
    case 'http:':
      return http;
    case 'https:':
      return https;
    default:
      throw new Error('protocol not supported');
  }
};

const createProxiedConnection = (options: RequestOptions) => {
  if (!options.proxy) {
    throw new Error('unreachable');
  }

  const passthrough = new PassThrough();
  const conn = new Connection(passthrough, options);

  const proxyAuth =
    options.proxy?.username &&
    options.proxy?.password &&
    'Basic ' + Buffer.from(`${options.proxy.username}:${options.proxy.password}`).toString('base64');

  const proxyHttpLib = httpLib(options.proxy.uri.protocol);
  const targetHttpLib = httpLib(options.uri.protocol);

  const proxyPath = util.format(
    '%s:%s',
    options.uri.hostname,
    options.uri.port || (targetHttpLib === http ? '80' : '443')
  );

  proxyHttpLib
    .request({
      host: options.proxy.uri.hostname,
      port: options.proxy.uri.port,
      headers: {
        host: options.uri.host,
        'User-Agent': (options.headers && options.headers['user-agent']) || defaultUserAgent,
        ...(proxyAuth ? { 'Proxy-Authorization': proxyAuth } : undefined),
      },
      method: 'CONNECT',
      path: proxyPath,
      agent: false,
      ...options.proxy.tls,
    })
    .on('connect', function (_, socket) {
      const req = targetHttpLib
        .request(options.uri, {
          method: options.method && options.method.toUpperCase(),
          headers: { 'User-Agent': defaultUserAgent, ...options.headers },
          auth: options.auth && options.auth.username + ':' + options.auth.password,
          createConnection: () => {
            if (options.uri.protocol === 'http:') {
              return socket;
            }
            return tls.connect(0, { ...options.tls, servername: options.uri.host, socket });
          },
        })
        .on('error', err => conn.emit('error', err))
        .on('response', response => conn.emit('response', response));
      conn.emit('request', req);
      passthrough.pipe(req);
    })
    .on('error', err => conn.emit('error', err))
    .end();

  return conn;
};

const createConnection = (options: RequestOptions) => {
  const req = httpLib(options.uri.protocol).request(options.uri, {
    method: options.method && options.method.toUpperCase(),
    headers: { 'User-Agent': defaultUserAgent, ...options.headers },
    auth: options.auth && options.auth.username + ':' + options.auth.password,
    agent: options.agent,
    ...options.tls,
  });

  const responsePromise = new Promise((resolve, reject) =>
    req.on('response', resp => {
      if (options.maxRedirects > 0 && resp.statusCode && resp.statusCode >= 301 && resp.statusCode <= 303) {
        const location = resp.headers.location;
        const qualifiedRedirection =
          location && location.startsWith('/') ? options.uri.origin + location : location || '/';

        // we do no want to leak memory so we must consume response stream,
        // but we do not want to destroy the response as that would destroy the underlying
        // socket and our agent could possible reuse it.
        resp.on('data', () => {});

        return request
          .get(qualifiedRedirection, { maxRedirects: options.maxRedirects - 1 })
          .on('response', nextResp => {
            nextResp.redirects = [qualifiedRedirection, ...(nextResp.redirects || [])];
            resolve(nextResp);
          })
          .on('error', reject);
      }
      return resolve(resp);
    })
  );

  const conn = new Connection(req, options);
  conn.emit('request', req);

  responsePromise.then(
    response => conn.emit('response', response),
    err => conn.emit('error', err)
  );

  return conn;
};

function isUri(value: any) {
  return typeof value === 'string' || value instanceof URL;
}

export function _request(uri: string | Options, opts?: Options) {
  const options = sanitizeOpts(isUri(uri) ? { ...opts, uri } : { ...opts, ...uri });

  if (options.path) {
    options.uri.pathname = options.path;
  }

  if (options.qs) {
    options.uri.search = qs.stringify({
      ...Object.fromEntries(options.uri.searchParams),
      ...options.qs,
    });
  } else if (options.query) {
    options.uri.search = querystring.stringify({
      ...Object.fromEntries(options.uri.searchParams),
      ...options.query,
    });
  }

  const conn = options.proxy ? createProxiedConnection(options) : createConnection(options);

  if (!options.method || options.method.toLowerCase() === 'get') {
    conn.end();
  } else if (typeof options.body === 'string' || options.body instanceof Buffer) {
    conn.setHeader('Content-Length', options.body.length);
    conn.end(options.body);
  } else if (options.body instanceof Readable && (options.body as any)._readableState.objectMode === false) {
    options.body.pipe(conn);
  } else if (options.body !== undefined) {
    const payload = JSON.stringify(options.body);
    conn.setHeader('Content-Type', 'application/json; charset=utf-8');
    conn.setHeader('Content-Length', payload.length);
    conn.end(payload);
  } else if (options.form) {
    const payload = qs.stringify(options.form);
    conn.setHeader('Content-Type', 'application/x-www-form-urlencoded');
    conn.setHeader('Content-Length', payload.length);
    conn.end(payload);
  } else if (options.formData) {
    const form = new FormData();
    for (const [key, value] of Object.entries(options.formData)) {
      form.append(key, value, { filename: key });
    }
    conn.setHeader('Content-Type', 'multipart/form-data;boundary=' + form.getBoundary());
    form.pipe(conn);
  }

  return conn;
}

type BaseRequestFunc = typeof _request;

const wrapWithDefaults = (fn: BaseRequestFunc, defaults: Options): BaseRequestFunc => {
  return (uri, opts = {}) => {
    if (isUri(uri)) {
      return fn(uri, { ...defaults, ...opts });
    }
    return fn({ ...defaults, ...uri });
  };
};

const methods = ['get', 'post', 'put', 'delete', 'head', 'options'] as const;

const methodRequests = methods.reduce((acc, verb) => {
  acc[verb] = wrapWithDefaults(_request, { method: verb });
  return acc;
}, {} as Record<typeof methods[number], BaseRequestFunc>);

export const request = Object.assign(_request, methodRequests, {
  defaults: (opts: Options): BaseRequestFunc => wrapWithDefaults(_request, opts),
});

export type Request = typeof request;
