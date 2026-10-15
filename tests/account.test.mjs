import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, verify } from '@node-rs/argon2';
import { createTestServer } from './helpers/server.mjs';
import { digest } from '../lib/portal.mjs';

test('account settings, required names and password security',async t=>{
  const app=await createTestServer();t.after(()=>app.close());
  const patch=(user,body,headers={})=>app.request(user,'/api/account',{method:'PATCH',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const password=(user,body,headers={})=>app.request(user,'/api/account/password',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  await t.test('names and preferences are validated and limited to the signed-in account',async()=>{
    assert.equal((await fetch(app.base+'/api/account')).status,401);
    assert.equal((await patch(1,{firstName:'Sam',lastName:'Scout'},{'x-csrf-token':'invalid'})).status,403);
    assert.equal((await patch(1,{firstName:'Sam',lastName:' '})).status,400);
    assert.equal((await patch(1,{theme:'unknown'})).status,400);
    assert.equal((await patch(1,{firstName:' Sam ',lastName:' Scout ',theme:'dark',reduceMotion:true,user_id:'2',permission:'portal:admin'})).status,200);
    const account=await (await app.request(1,'/api/account')).json();
    assert.equal(account.user.firstName,'Sam');assert.equal(account.user.lastName,'Scout');
    assert.deepEqual(account.preferences,{theme:'dark',reduceMotion:true});
    assert.deepEqual(account.permissions,['scouting:read']);
    assert.ok(!JSON.stringify(account).includes('password_hash'));
    assert.equal((await (await app.request(2,'/api/account')).json()).user.firstName,'');
  });
  await t.test('signup requires first and last names on the server as well as in the form',async()=>{
    const page=await fetch(app.base+'/signup'),html=await page.text();
    assert.match(html,/name="first_name"[^>]*required/);assert.match(html,/name="last_name"[^>]*required/);
    const cookie=page.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),csrf=html.match(/name="csrf_token" value="([^"]+)"/)[1];
    const form={email:'new@example.org',password:'A-long-test-password',confirm_password:'A-long-test-password',csrf_token:csrf};
    const signup=body=>fetch(app.base+'/signup',{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...form,...body})});
    assert.equal((await signup({})).status,400);
    assert.equal((await signup({first_name:'Only first'})).status,400);
    assert.equal((await signup({first_name:' Zoë ',last_name:' Li '})).status,303);
    const user=(await app.db.query("SELECT first_name,last_name FROM shared_login.portal_users WHERE email='new@example.org'")).rows[0];
    assert.deepEqual(user,{first_name:'Zoë',last_name:'Li'});
  });
  await t.test('password changes require the old password and revoke other sessions atomically',async()=>{
    const old='Old-test-password-123',next='New-test-password-456';
    await app.db.query('UPDATE shared_login.portal_users SET password_hash=$2 WHERE id=$1',[1,await hash(old)]);
    await app.db.query("INSERT INTO shared_login.portal_sessions(token_hash,user_id,expires_at) VALUES($1,1,now()+interval '1 hour')",[digest('other-test-session')]);
    assert.equal((await password(1,{currentPassword:old,newPassword:next,confirmPassword:next},{'x-csrf-token':'bad'})).status,403);
    assert.equal((await password(1,{currentPassword:'wrong',newPassword:next,confirmPassword:next})).status,400);
    assert.equal((await password(1,{currentPassword:old,newPassword:next,confirmPassword:'mismatch'})).status,400);
    assert.equal((await password(1,{currentPassword:old,newPassword:next,confirmPassword:next})).status,200);
    const encoded=(await app.db.query('SELECT password_hash FROM shared_login.portal_users WHERE id=1')).rows[0].password_hash;
    assert.equal(await verify(encoded,next),true);assert.equal(await verify(encoded,old),false);
    assert.equal((await app.request(1,'/api/account')).status,200);
    assert.equal((await fetch(app.base+'/api/account',{headers:{cookie:'team1833_session=other-test-session'}})).status,401);
    assert.equal((await password(1,{currentPassword:old,newPassword:next,confirmPassword:next})).status,400);
  });
  await t.test('repeated incorrect password attempts are rate limited',async()=>{
    for(let i=0;i<5;i++)assert.equal((await password(2,{currentPassword:'wrong',newPassword:'A-long-test-password',confirmPassword:'A-long-test-password'})).status,400);
    assert.equal((await password(2,{currentPassword:'wrong',newPassword:'A-long-test-password',confirmPassword:'A-long-test-password'})).status,429);
  });
  await t.test('settings remain available without scouting permissions; public branding serves with correct types',async()=>{
    await app.db.query('DELETE FROM shared_login.portal_permissions WHERE user_id=4');
    assert.equal((await app.request(4,'/settings')).status,200);
    assert.equal((await app.request(4,'/api/account')).status,200);
    assert.equal((await app.request(4,'/scouting/api/auth/me')).status,403);
    for(const [path,type]of [['theme.js','text/javascript'],['chewy.ttf','font/ttf'],['icon.png','image/png']]){
      const response=await fetch(app.base+'/scouting/'+path);
      assert.equal(response.status,200);assert.ok(response.headers.get('content-type').startsWith(type));
    }
  });
});
