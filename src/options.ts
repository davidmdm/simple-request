import * as url from 'url';
import * as http from 'http';
import * as tls from 'tls';

const getMaxRedirects = (opts: Options): number => {
  if (typeof opts.maxRedirects === 'number') {
    return Math.max(Math.floor(opts.maxRedirects), 0);
  }
  if (opts.followAllRedirects === true) {
    return Infinity;
  }
  return 0;
};

export type RequestOptions = {
  method: string;
  headers: Record<string, string | string[]>;
  uri: url.URL;
  proxy?: {
    uri: url.URL;
    username?: string;
    password?: string;
    tls?: tls.ConnectionOptions;
  };
  maxRedirects: number;
  auth?: { username: string; password: string };
  body: any;
  form: any;
  formData: any;
  qs?: Record<string, any>;
  query?: Record<string, any>;
  decompress: boolean;
  rejectError: boolean;
  raw: boolean;
  tls?: tls.ConnectionOptions;
  simple: boolean;
  path?: string;
  agent?: http.RequestOptions['agent'];
};

export type URI = string | url.URL;

export type Options = Partial<
  Omit<RequestOptions, 'uri' | 'proxy'> & {
    uri: URI;
    proxy:
      | URI
      | {
          uri: URI;
          tls?: tls.ConnectionOptions;
          username?: string;
          password?: string;
        };
    followAllRedirects: boolean;
  }
>;

const uriToURL = (uri: URI): url.URL => {
  if (typeof uri === 'string') {
    return new url.URL(uri);
  }
  return uri;
};

export const sanitizeOpts = (opts: Options | string): RequestOptions => {
  if (typeof opts === 'string') {
    return sanitizeOpts({ uri: opts });
  }
  if (opts.uri === undefined) {
    throw new Error('begger: uri must be defined');
  }
  return {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    uri: uriToURL(opts.uri),
    proxy: (() => {
      if (opts.proxy === undefined) {
        return undefined;
      }
      if (typeof opts.proxy === 'string') {
        return { uri: uriToURL(opts.proxy) };
      }
      if (opts.proxy instanceof url.URL) {
        return { uri: opts.proxy };
      }
      return {
        uri: uriToURL(opts.proxy.uri),
        tls: opts.proxy.tls,
        username: opts.proxy.username,
        password: opts.proxy.password,
      };
    })(),
    maxRedirects: getMaxRedirects(opts),
    auth: opts.auth,
    body: opts.body,
    form: opts.form,
    formData: opts.formData,
    qs: opts.qs,
    query: opts.query,
    decompress: opts.decompress !== false,
    rejectError: opts.rejectError === true,
    raw: opts.raw === true,
    tls: opts.tls,
    simple: opts.simple === true,
    path: opts.path,
  };
};
