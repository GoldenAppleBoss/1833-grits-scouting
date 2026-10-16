export const SELECTION_METRICS={adjustedOPR:'Adjusted fuel OPR',passingOPR:'Scouted passing OPR',autoFuel:'Autonomous fuel',teleopFuel:'Teleop fuel',totalFuel:'Total fuel',totalPassed:'Fuel passed',reliability:'Reliability %',cycles:'Estimated cycles',subjectiveRank:'Subjective rank',agilityRank:'Agility rank',fieldAwarenessRank:'Awareness rank',driverAbilityRank:'Driver rank',defenseAverage:'Defense effectiveness'};
export const LOWER_BETTER=new Set(['subjectiveRank','agilityRank','fieldAwarenessRank','driverAbilityRank']);
export const initialWorkspace=()=>({board:{rows:8,columns:3,slots:Array.from({length:8},()=>[null,null,null])},lists:[],hiddenTeams:[]});
const error=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
const conflict=message=>error(message+' Refresh and try again.',409);
const text=(value,max,label)=>{if(typeof value!=='string'||value.length>max)error(`Invalid ${label}`);return value.trim();};
export function findSlot(board,team){for(let row=0;row<board.rows;row++)for(let column=0;column<board.columns;column++)if(board.slots[row][column]===team)return{row,column};return null;}
export function applySelectionOperation(input,op,teams,actor,revision){
  const state=structuredClone(input),allowed=new Set(teams),board=state.board;
  const team=n=>{if(!Number.isInteger(n)||!allowed.has(n))error('Choose a team from the imported event');return n;};
  const slot=(row,column)=>{if(!Number.isInteger(row)||!Number.isInteger(column)||row<0||row>=board.rows||column<0||column>=board.columns)error('Choose a valid alliance slot');return board.slots[row][column];};
  const list=()=>{const found=state.lists.find(l=>l.id===op.listId);if(!found)error('This list no longer exists',404);return found;};
  const listRevision=l=>{if(op.expectedRevision!==l.revision)conflict('Another user changed this list.');};
  let description='';
  switch(op.type){
    case'board.assign':{
      const n=team(op.teamNumber),value=slot(op.row,op.column),source=findSlot(board,n);
      if(value!==op.expectedTeam)conflict('This alliance slot has changed.');
      const expected=op.expectedSource??null;if(source===null?expected!==null:!expected||source.row!==expected.row||source.column!==expected.column)conflict('This robot moved to another slot.');
      if(value!==null&&value!==n&&!op.replace)error('The slot is occupied. Clear it or confirm replacement.');
      if(source)board.slots[source.row][source.column]=null;
      board.slots[op.row][op.column]=n;description=`Placed ${n} in alliance ${op.row+1}, ${['captain','1st pick','2nd pick','3rd pick'][op.column]}`;break;
    }
    case'board.clear':{
      const value=slot(op.row,op.column);if(value!==op.expectedTeam)conflict('This alliance slot has changed.');
      board.slots[op.row][op.column]=null;description=`Returned ${value??'empty slot'} to the pool`;break;
    }
    case'board.swap':{
      const a=slot(op.row,op.column),b=slot(op.otherRow,op.otherColumn);
      if(a!==op.expectedTeam||b!==op.expectedOtherTeam)conflict('One of these alliance slots changed.');
      board.slots[op.row][op.column]=b;board.slots[op.otherRow][op.otherColumn]=a;description=`Swapped ${a??'empty slot'} and ${b??'empty slot'}`;break;
    }
    case'board.layout':{
      if(op.expectedRevision!==revision)conflict('The draft board changed.');
      if(!Number.isInteger(op.rows)||op.rows<1||op.rows>16||![3,4].includes(op.columns))error('Use 1–16 alliances and three or four columns');
      const removed=board.slots.flatMap((r,i)=>r.filter((v,j)=>v!=null&&(i>=op.rows||j>=op.columns)));
      if(removed.length&&!op.allowDrop)error('This layout removes occupied slots. Confirm returning those robots to the pool.');
      state.board={rows:op.rows,columns:op.columns,slots:Array.from({length:op.rows},(_,r)=>Array.from({length:op.columns},(_,c)=>board.slots[r]?.[c]??null))};description=`Set draft layout to ${op.rows} alliances × ${op.columns} robots`;break;
    }
    case'pool.hide':{
      const n=team(op.teamNumber);state.hiddenTeams=state.hiddenTeams.filter(x=>x!==n);if(op.hidden===true)state.hiddenTeams.push(n);description=`${op.hidden?'Marked unavailable':'Restored'} team ${n}`;break;
    }
    case'list.create':{
      if(state.lists.length>=30)error('Use up to 30 lists per event');
      if(typeof op.listId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(op.listId)||state.lists.some(l=>l.id===op.listId))error('Invalid or duplicate list ID');
      const name=text(op.name,100,'list name');if(!name)error('Name the list');
      const copy=op.copyFrom?state.lists.find(l=>l.id===op.copyFrom):null;if(op.copyFrom&&!copy)error('Source list no longer exists');
      state.lists.push({id:op.listId,name,description:'',revision:1,teams:copy?structuredClone(copy.teams):[],columns:copy?[...copy.columns]:['adjustedOPR','passingOPR','subjectiveRank','reliability'],comments:[]});description=`Created list “${name}”`;break;
    }
    case'list.configure':{
      const l=list();listRevision(l);const name=text(op.name,100,'list name');if(!name)error('Name the list');
      if(!Array.isArray(op.columns)||op.columns.length>8||new Set(op.columns).size!==op.columns.length||op.columns.some(k=>!SELECTION_METRICS[k]))error('Choose up to eight metric columns');
      l.name=name;l.description=text(op.description,4000,'list description');l.columns=op.columns;l.revision++;description=`Configured list “${name}”`;break;
    }
    case'list.delete':{
      const l=list();listRevision(l);state.lists=state.lists.filter(x=>x.id!==l.id);description=`Deleted list “${l.name}”`;break;
    }
    case'list.add':{
      const l=list(),n=team(op.teamNumber);if(!l.teams.some(t=>t.number===n)){l.teams.push({number:n,note:''});l.revision++;}description=`Added ${n} to “${l.name}”`;break;
    }
    case'list.remove':{
      const l=list(),n=team(op.teamNumber),item=l.teams.find(t=>t.number===n);if(item&&item.note!==op.expectedNote)conflict('This robot’s planning note changed.');l.teams=l.teams.filter(t=>t.number!==n);l.revision++;description=`Removed ${n} from “${l.name}”`;break;
    }
    case'list.reorder':{
      const l=list();listRevision(l);
      if(!Array.isArray(op.order)||op.order.length!==l.teams.length||new Set(op.order).size!==op.order.length||op.order.some(n=>!l.teams.some(t=>t.number===n)))error('Reordering must retain exactly the teams already in this list');
      const byNumber=new Map(l.teams.map(t=>[t.number,t]));l.teams=op.order.map(n=>byNumber.get(n));l.revision++;description=`Reordered “${l.name}”`;break;
    }
    case'list.team-note':{
      const l=list(),t=l.teams.find(t=>t.number===op.teamNumber);if(!t)error('This team is no longer in the list',404);
      if(t.note!==op.expectedNote)conflict('Another user changed this team note.');
      t.note=text(op.note,4000,'team note');l.revision++;description=`Updated ${t.number} notes in “${l.name}”`;break;
    }
    case'list.comment':{
      const l=list(),body=text(op.text,4000,'comment');if(!body)error('Write a comment');if(l.comments.length>=200)error('This list already has 200 comments');
      if(typeof op.commentId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(op.commentId)||l.comments.some(c=>c.id===op.commentId))error('Invalid or duplicate comment ID');
      l.comments.push({id:op.commentId,text:body,author:actor.name,userId:actor.id,time:actor.time});l.revision++;description=`Commented on “${l.name}”`;break;
    }
    case'list.comment-remove':{
      const l=list(),comment=l.comments.find(c=>c.id===op.commentId);if(!comment)error('This comment no longer exists',404);if(comment.userId!==actor.id&&!actor.admin)error('Only the author or an administrator may remove a comment',403);l.comments=l.comments.filter(c=>c.id!==op.commentId);l.revision++;description=`Removed a comment from “${l.name}”`;break;
    }
    default:error('Unknown alliance selection operation');
  }
  return{state,description};
}
export function metricValues(team,rating,weight=.5){
  const q=team.quantitative||{},s=team.qualitative||{},official=rating?.tbaFuelOPR,scouted=rating?.scoutingOPR;
  return{...Object.fromEntries(Object.entries(q).map(([k,v])=>[k,v?.mean??null])),...s.averages,defenseAverage:s.defenseAverage??null,adjustedOPR:weight===0?official??null:weight===1?scouted??null:official==null||scouted==null?null:weight*scouted+(1-weight)*official,passingOPR:rating?.scoutingPassingOPR??null};
}
export function rankedTeams(teams,values,key){return[...teams].sort((a,b)=>{const av=values(a)[key],bv=values(b)[key];return av==null?bv==null?a-b:1:bv==null?-1:(LOWER_BETTER.has(key)?av-bv:bv-av)||a-b;});}
