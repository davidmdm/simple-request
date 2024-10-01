const http = require('http');
const { Duplex } = require('stream');

const zlib = require('zlib');

const decompressions = {
  gzip: zlib.createGunzip,
  deflate: zlib.createInflate,
  br: zlib.createBrotliDecompress,
};

const validEncodings = ['gzip', 'br', 'deflate', 'identity'];
function getValidEncodings(contentEncoding = '') {
  const encodings = contentEncoding
    .split(/\s*,\s*/)
    .filter(enc => enc && enc !== 'identity')
    .map(enc => enc.toLowerCase());
  if (encodings.some(enc => !validEncodings.includes(enc))) {
    // Signal invalid encodings by returning null
    return null;
  }
  return encodings;
}

function applyDecompression(response) {
  const encodings = getValidEncodings(response.headers['content-encoding']);
  if (encodings === null) {
    return response;
  }
  return encodings.reduceRight((acc, enc) => acc.pipe(decompressions[enc]()), response);
}

function pump(src, dst) {
  src.once('readable', () => {
    for (;;) {
      const chunk = src.read();
      if (chunk === null) {
        return;
      }
      dst.push(chunk);
    }
  });
}

function readableToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const parts = [];
    readable
      .on('data', data => parts.push(data))
      .on('end', () => resolve(Buffer.concat(parts)))
      .on('error', reject);
  });
}

function statusOk(statusCode) {
  return statusCode >= 200 && statusCode < 300;
}

class HttpError extends Error {
  constructor(statusCode, message, headers, body) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.headers = headers;
    this.body = body;
  }
}

class CancelError extends Error {
  constructor() {
    super('Request Cancelled');
  }
}

function parseResponseBuffer(contentType = '', buffer) {
  if (contentType.startsWith('application/json')) {
    return buffer.length > 0 ? JSON.parse(buffer.toString()) : undefined;
  }
  if (contentType.startsWith('text')) {
    return buffer.toString();
  }
  return buffer;
}

function getResponseError(response, buffer) {
  const payload = parseResponseBuffer(response.headers['content-type'], buffer);
  if (typeof payload === 'string' || payload instanceof Buffer) {
    return new HttpError(
      response.statusCode,
      http.STATUS_CODES[response.statusCode],
      response.headers,
      buffer.toString()
    );
  }
  return new HttpError(
    response.statusCode,
    payload.message || http.STATUS_CODES[response.statusCode],
    response.headers,
    payload
  );
}

class Connection extends Duplex {
  constructor(dst, opts) {
    super();
    this.dst = dst;
    this.opts = opts;
    this.source = null;
    this.incomingMessage = null;
    this.outgoingMessage = null;
    this.responsePromise = null;
    this.outgoingHeaders = {};
    this.isCancelled = false;

    const pipe = Duplex.prototype.pipe.bind(this);
    this.isPipedTo = false;
    this.pipe = (...args) => {
      if (!this.isPipedTo) {
        this.end();
      }
      return pipe(...args);
    };

    this.once('response', response => {
      response.once('close', () => this.emit('close'));
      response.once('error', err => this.emit('error', err));
      this.incomingMessage = response;
      this.source = opts.decompress ? applyDecompression(response) : response;
      this.source.on('end', () => this.push(null));
      this.emit('_source_');
    })
      .once('request', request => {
        request.once('error', err => this.emit('error', err));
        request.once('abort', () => {
          this.emit('abort');
          if (!this.responsePromise) {
            const err = new CancelError();
            this.responsePromise = Promise.reject(err);
            this.responsePromise.catch(() => {}); // avoid throwing unhandled rejection
            this.emit('error', err);
          }
        });
        this.outgoingMessage = request;
        for (const [name, value] of Object.entries(this.outgoingHeaders)) {
          this.outgoingMessage.setHeader(name, value);
        }
      })
      .once('finish', () => this.dst.end())
      .once('pipe', () => (this.isPipedTo = true));
  }

  _read() {
    if (!this.source) {
      return this.once('_source_', () => pump(this.source, this));
    }
    pump(this.source, this);
  }

  _write(chunk, enc, cb) {
    this.dst.write(chunk, enc, cb);
  }

  _destroy(err, cb) {
    if (this.outgoingMessage) {
      this.outgoingMessage.destroy(err);
    } else {
      this.once('request', request => request.destroy(err));
    }
    if (this.incomingMessage) {
      this.incomingMessage.destroy(err);
    } else {
      this.once('response', response => response.destroy(err));
    }
    cb(err);
  }

  setHeader(name, value) {
    this.outgoingHeaders[name] = value;
    if (this.outgoingMessage) {
      this.outgoingMessage.setHeader(name, value);
    }
  }

  cancel() {
    if (!this.outgoingMessage) {
      this.once('request', () => request => request.abort());
    } else {
      // if cancel is called synchonously on connection, errors might be thrown before
      // there was a chance to register handlers. Abort asynchronously.
      process.nextTick(() => this.outgoingMessage.abort());
    }
    this.isCancelled = true;
  }

  then(fn, handle) {
    if (!this.responsePromise && this.outgoingMessage && this.outgoingMessage.aborted) {
      this.responsePromise = Promise.reject(new CancelError());
    }
    if (!this.responsePromise) {
      //@ts-ignore
      this.responsePromise = Promise.race([
        (async () => {
          if (!this.isPipedTo) {
            this.end();
          }
          const response = this.incomingMessage || (await new Promise(resolve => this.once('response', resolve)));
          const buffer = await readableToBuffer(this);
          if ((this.opts.rejectError || this.opts.simple) && !statusOk(response.statusCode)) {
            throw getResponseError(response, buffer);
          }

          const encodings = getValidEncodings(response.headers['content-encoding']);
          // Encodings is null when invalid encodings are contained in Content-Encoding
          const shouldUseRawBuffer =
            this.opts.raw || encodings === null || (this.opts.decompress === false && encodings.length > 0);

          const body = shouldUseRawBuffer ? buffer : parseResponseBuffer(response.headers['content-type'], buffer);

          if (this.opts.simple) {
            return body;
          }

          response.body = body;
          return response;
        })(),
        new Promise((_, reject) => {
          this.once('error', reject);
          this.once('abort', () => reject(new CancelError()));
        }),
      ]);
    }
    return this.responsePromise.then(fn, handle);
  }

  catch(handle) {
    if (this.responsePromise) {
      return this.responsePromise.catch(handle);
    }
    return this.then(x => x, handle);
  }
}

module.exports = { Connection, CancelError, HttpError };
