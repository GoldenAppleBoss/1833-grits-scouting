import http from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import handler from '../../api/index.mjs';
import { digest, csrf } from '../../lib/portal.mjs';
import { closeDatabase } from '../../lib/db.mjs';
import { COUNTERS } from '../../scouting/public/model.js';

export async function createTestServer() {
  const db = new PGlite();
  const folder = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(folder)).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,folder),'utf8'));
  const users = [
    {id:1,email:'quant@example.org',permissions:['scouting:read']},
    {id:2,email:'analytics@example.org',permissions:['scouting:read','scouting:analytics']},
    {id:3,email:'admin@example.org',permissions:['scouting:read','portal:admin']},
    {id:4,email:'unassigned@example.org',permissions:['scouting:read']},
    {id:5,email:'other@example.org',permissions:['scouting:read']}
  ];
  for(const user of users){
    await db.query('INSERT INTO shared_login.portal_users(id,email,password_hash) VALUES($1,$2,$3)',[user.id,user.email,'not-a-login-hash']);
    for(const permission of user.permissions)await db.query('INSERT INTO shared_login.portal_permissions(user_id,permission) VALUES($1,$2)',[user.id,permission]);
    await db.query("INSERT INTO shared_login.portal_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[digest(`test-token-${user.id}`),user.id]);
  }
  await db.exec(`INSERT INTO scouting.events(event_key,name,imported_at) VALUES('2026test','Test Invitational',now());
    INSERT INTO scouting.teams(event_key,team_number,name) VALUES('2026test',1833,'Team BEAN'),('2026test',100,'Red Two'),('2026test',200,'Red Three'),('2026test',300,'Blue One'),('2026test',400,'Blue Two'),('2026test',500,'Blue Three');
    INSERT INTO scouting.matches(event_key,match_key,match_number,comp_level,red,blue) VALUES
      ('2026test','qm1',1,'qm',ARRAY[1833,100,200],ARRAY[300,400,500]),
      ('2026test','qm2',2,'qm',ARRAY[1833,100,200],ARRAY[300,400,500]);
    INSERT INTO scouting.rotations(event_key,user_id,rotation,rotation_count,alliance,station) VALUES('2026test',1,1,1,'red',1);`);
  const originalPool = pg.Pool, originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
  let queue = Promise.resolve();
  const query = async (sql, params) => {
    const result = params?.length ? await db.query(sql,params) : (await db.exec(sql)).at(-1);
    return {...result,rowCount:result.rows.length || result.affectedRows || 0};
  };
  pg.Pool = class {
    on() {}
    async connect() {
      const previous = queue;
      let release;
      queue = new Promise(resolve=>{release=resolve;});
      await previous;
      return {query,release};
    }
    async query(...args) { const client = await this.connect(); try{return await query(...args);}finally{client.release();} }
    async end() {await queue;}
  };
  const server = http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (user,path,options={}) => fetch(base+path,{
    ...options,redirect:'manual',headers:{cookie:`team1833_session=test-token-${user}`,'x-csrf-token':csrf(`test-token-${user}`),...options.headers}
  });
  return {base,db,users,request,async close(){
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await closeDatabase();pg.Pool=originalPool;
    if(originalUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=originalUrl;
    await db.close();
  }};
}
export function testRecord(edits={}) {
  return {...Object.fromEntries(COUNTERS.map(k=>[k,0])),recordId:randomUUID(),deviceId:'test-device',schemaVersion:4,
    eventKey:'2026test',matchKey:'qm1',matchNumber:1,teamNumber:1833,alliance:'red',kind:'quantitative',ownerUserId:'1',revision:1,
    completed:false,startingLocation:'Center',robotStatus:'Normal',robotStatusPeriod:'',autoClimb:false,endgameLevel:0,tags:[],notes:'',...edits};
}
