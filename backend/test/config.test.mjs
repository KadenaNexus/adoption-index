import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountsConfig} from '../src/config.mjs';
// What `npm run check-config` reports: every mistake that would switch accounts or admin access off must throw.
const base={PUBLIC_SITE_URL:'https://adoption.kadena.ws',MAIL_TRANSPORT:'log'};

test('SITE_API_KEY: unset or empty turns accounts off, a set key needs at least 32 characters',()=>{
 for(const value of [undefined,''])assert.equal(accountsConfig({...base,SITE_API_KEY:value}).siteKey,null);
 assert.equal(accountsConfig({...base,SITE_API_KEY:'k'.repeat(32)}).siteKey,'k'.repeat(32));
 for(const value of ['abc','k'.repeat(31)])assert.throws(()=>accountsConfig({...base,SITE_API_KEY:value}),/SITE_API_KEY must be at least 32 characters/,value);
});
test('ADMIN_EMAILS: comma-separated addresses, normalised; any entry that is not an address is refused',()=>{
 assert.deepEqual([...accountsConfig({...base,ADMIN_EMAILS:' Me@X.io , naif@kadena.ws,'}).adminEmails],['me@x.io','naif@kadena.ws']);
 assert.deepEqual([...accountsConfig(base).adminEmails],[]);
 for(const value of ['me@x.io;naif@kadena.ws','me@x.io naif@kadena.ws','<me@x.io>,naif@kadena.ws','me@x.io,naif'])
  assert.throws(()=>accountsConfig({...base,ADMIN_EMAILS:value}),/ADMIN_EMAILS must be comma-separated email addresses/,value);
});
test('SUPPORT_EMAIL: an address, or none when unset, so an admin address is never made public',()=>{
 assert.equal(accountsConfig({...base,SUPPORT_EMAIL:'Help@Kadena.ws'}).mail.supportEmail,'help@kadena.ws');
 assert.equal(accountsConfig({...base,ADMIN_EMAILS:'ops@kadena.ws,naif@kadena.ws'}).mail.supportEmail,null);
 assert.throws(()=>accountsConfig({...base,SUPPORT_EMAIL:'help at kadena.ws'}),/SUPPORT_EMAIL is not a valid email address/);
});
