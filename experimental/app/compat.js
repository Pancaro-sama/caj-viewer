/* ==========================================================================
 * 旧版 Safari / iPadOS 兼容垫片
 *
 * 为什么需要：
 *   vendor/pdfjs/build/pdf.min.js 是 pdfjs-dist 6.x 的构建产物，它在运行期用到
 *   若干 2022-2024 年才加入 Safari 的 API（Promise.withResolvers、
 *   Uint8Array.fromBase64/fromHex、Object.hasOwn、Array.prototype.at 等）。
 *   Safari 16.4 之前这些都不存在，缺一个就会在使用到它的那一刻抛
 *   "Promise.withResolvers is not a function"，而且往往发生在加载 PDF 的过程中，
 *   在 iPad 上表现为「点开文件没反应」，极难自行定位。
 *
 * 这一层只做「补齐缺失的标准方法」，不改写已有实现：凡浏览器自带的都原样保留。
 * 它是一个经典脚本（不是模块），所以在 index.html 里必须排在模块脚本之前，
 * 并且不能使用 import/export 或顶层 await。
 *
 * 不能靠这里补救的语法层面差异（这几个是解析期就会报错的）：
 *   #private 字段 / static 初始化块 / ??= 逻辑赋值 —— 需要 Safari 14.1+；
 *   顶层 await —— 需要 Safari 15+。
 * 也就是说本文件把门槛从 Safari 16.4 拉回到 Safari 15 左右。
 * ========================================================================== */

(function () {
  'use strict';

  var P = Promise;

  /* Promise.withResolvers() —— Safari 17.4+。pdf.js 6.x 在构造传输层时就用它。 */
  if (typeof P.withResolvers !== 'function') {
    P.withResolvers = function () {
      var resolve, reject;
      var promise = new P(function (res, rej) { resolve = res; reject = rej; });
      return { promise: promise, resolve: resolve, reject: reject };
    };
  }

  /* Promise.any() —— Safari 14+（备份，逻辑同上思路：缺失才补）。 */
  if (typeof P.any !== 'function') {
    P.any = function (iterable) {
      var items = Array.from(iterable);
      return new P(function (resolve, reject) {
        if (items.length === 0) {
          reject(new (typeof AggregateError === 'function' ? AggregateError : Error)('全部失败'));
          return;
        }
        var errors = new Array(items.length);
        var left = items.length;
        items.forEach(function (item, i) {
          P.resolve(item).then(resolve, function (err) {
            errors[i] = err;
            if (--left === 0) {
              reject(new (typeof AggregateError === 'function' ? AggregateError : Error)('全部失败'));
            }
          });
        });
      });
    };
  }

  /* Object.hasOwn() —— Safari 15.4+ */
  if (typeof Object.hasOwn !== 'function') {
    Object.hasOwn = function (obj, prop) {
      if (obj === null || obj === undefined) throw new TypeError('Cannot convert undefined or null to object');
      return Object.prototype.hasOwnProperty.call(Object(obj), prop);
    };
  }

  /* Array.prototype.at() —— Safari 15.4+ */
  if (typeof Array.prototype.at !== 'function') {
    /* eslint-disable no-extend-native */
    Object.defineProperty(Array.prototype, 'at', {
      value: function at(index) {
        var len = this.length >>> 0;
        var i = Math.trunc(Number(index) || 0);
        if (i < 0) i += len;
        return i < 0 || i >= len ? undefined : this[i];
      },
      writable: true, configurable: true,
    });
    if (typeof String.prototype.at !== 'function') {
      Object.defineProperty(String.prototype, 'at', {
        value: function at(index) {
          return Array.prototype.at.call(this, index);
        },
        writable: true, configurable: true,
      });
    }
  }

  /* Array.prototype.findLast / findLastIndex() —— Safari 15.4+ */
  if (typeof Array.prototype.findLast !== 'function') {
    Object.defineProperty(Array.prototype, 'findLast', {
      value: function findLast(fn, thisArg) {
        for (var i = this.length - 1; i >= 0; i--) {
          if (fn.call(thisArg, this[i], i, this)) return this[i];
        }
        return undefined;
      },
      writable: true, configurable: true,
    });
  }
  if (typeof Array.prototype.findLastIndex !== 'function') {
    Object.defineProperty(Array.prototype, 'findLastIndex', {
      value: function findLastIndex(fn, thisArg) {
        for (var i = this.length - 1; i >= 0; i--) {
          if (fn.call(thisArg, this[i], i, this)) return i;
        }
        return -1;
      },
      writable: true, configurable: true,
    });
  }

  /* Array.prototype.with() —— Safari 16.4+（pdf.js 不直接用，但成本极低） */
  if (typeof Array.prototype.with !== 'function') {
    Object.defineProperty(Array.prototype, 'with', {
      value: function with_(index, value) {
        var len = this.length >>> 0;
        var i = Math.trunc(Number(index) || 0);
        if (i < 0) i += len;
        if (i < 0 || i >= len) throw new RangeError('Invalid index');
        var copy = Array.prototype.slice.call(this);
        copy[i] = value;
        return copy;
      },
      writable: true, configurable: true,
    });
  }

  /* String.prototype.replaceAll() —— Safari 13.1+ */
  if (typeof String.prototype.replaceAll !== 'function') {
    Object.defineProperty(String.prototype, 'replaceAll', {
      value: function replaceAll(search, replacement) {
        if (search instanceof RegExp) {
          if (!search.global) throw new TypeError('replaceAll 的第一个参数是正则时必须带 g 标志');
          return this.replace(search, replacement);
        }
        return this.split(String(search)).join(replacement);
      },
      writable: true, configurable: true,
    });
  }

  /* Uint8Array.fromBase64 / fromHex / toBase64 / setFromBase64 —— Safari 18.2+。
   * pdf.js 6.x 在读写内嵌二进制数据时用到 fromBase64/fromHex。 */
  function decodeBase64(str) {
    var clean = String(str).replace(/[\s]/g, '');
    if (typeof atob === 'function') {
      var bin = atob(clean);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof Buffer === 'function') return new Uint8Array(Buffer.from(clean, 'base64'));
    throw new Error('当前环境没有 atob，无法解码 base64');
  }

  function decodeHex(str) {
    var clean = String(str).replace(/[\s]/g, '');
    if (clean.length % 2 !== 0) throw new SyntaxError('十六进制字符串长度必须是偶数');
    var out = new Uint8Array(clean.length / 2);
    for (var i = 0; i < out.length; i++) {
      var byte = parseInt(clean.substr(i * 2, 2), 16);
      if (Number.isNaN(byte)) throw new SyntaxError('不是合法的十六进制字符串');
      out[i] = byte;
    }
    return out;
  }

  if (typeof Uint8Array.fromBase64 !== 'function') {
    Object.defineProperty(Uint8Array, 'fromBase64', {
      value: function fromBase64(str) { return decodeBase64(str); },
      writable: true, configurable: true,
    });
  }
  if (typeof Uint8Array.fromHex !== 'function') {
    Object.defineProperty(Uint8Array, 'fromHex', {
      value: function fromHex(str) { return decodeHex(str); },
      writable: true, configurable: true,
    });
  }
})();

/* 把「垫片是否被用到」留个记号，方便环境自检与端到端测试断言。 */
(function () {
  var missing = [];
  if (typeof Promise.withResolvers !== 'function') missing.push('Promise.withResolvers');
  if (typeof Object.hasOwn !== 'function') missing.push('Object.hasOwn');
  if (typeof Array.prototype.at !== 'function') missing.push('Array.prototype.at');
  if (typeof Array.prototype.findLast !== 'function') missing.push('Array.prototype.findLast');
  if (typeof Uint8Array.fromBase64 !== 'function') missing.push('Uint8Array.fromBase64');
  if (typeof Uint8Array.fromHex !== 'function') missing.push('Uint8Array.fromHex');
  globalThis.__cajPolyfillLeftover = missing;
})();
