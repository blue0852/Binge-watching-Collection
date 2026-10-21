import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlayUrls } from './vodApi.js';

test('解析标准 MacCMS 多线路 / 多集', () => {
  const files = parsePlayUrls(
    '线路1$$$线路2',
    '第1集$http://cdn.example.com/1.m3u8#第2集$http://cdn.example.com/2.m3u8$$$第1集$http://cdn2.example.com/1.m3u8',
  );
  assert.equal(files.length, 3);
  assert.equal(files[0].name, '线路1 · 第1集');
  assert.equal(files[0].url, 'http://cdn.example.com/1.m3u8');
  assert.equal(files[0].format, 'm3u8');
  assert.equal(files[2].name, '线路2 · 第1集');
});

test('# 作为集分隔符，空段被忽略', () => {
  const files = parsePlayUrls(
    '默认',
    'http://cdn.example.com/1.mp4#http://cdn.example.com/2.mp4#',
  );
  assert.equal(files.length, 2);
  assert.equal(files[0].url, 'http://cdn.example.com/1.mp4');
  assert.equal(files[1].name, '默认 · 播放');
  assert.equal(files[1].format, 'mp4');
});

test('极速资源 play 页补全为 m3u8 并丢弃假 mp4', () => {
  const files = parsePlayUrls(
    '极速',
    '第1集$https://vv.jisuzyv.com/play/abcd1234#第1集$https://vv.jisuzyv.com/play/abcd1234.mp4',
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].format, 'm3u8');
  assert.equal(files[0].url, 'https://vv.jisuzyv.com/play/abcd1234/index.m3u8');
});

test('同一线路内重复地址只保留一条', () => {
  const files = parsePlayUrls('线路1', '第1集$http://cdn.example.com/1.m3u8#第1集$http://cdn.example.com/1.m3u8');
  assert.equal(files.length, 1);
});

test('空值 / 非 http 地址被忽略', () => {
  assert.deepEqual(parsePlayUrls(undefined, undefined), []);
  assert.deepEqual(parsePlayUrls('线路1', '第1集$ftp://example.com/1.mp4###'), []);
});
