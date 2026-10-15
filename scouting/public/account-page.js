import { accountRequest,settingsMarkup,bindSettings,downloadMatches } from './settings.js';
let account,tab='account';
const root=document.querySelector('#accountSettingsRoot');
async function render(load=true){
  if(load)account=await accountRequest();
  if(!window.Team1833Appearance.hasLocal())window.Team1833Appearance.apply(account.preferences);
  root.innerHTML=settingsMarkup(account,{tab,standalone:true});
  bindSettings(root,{account,changeTab:async value=>{tab=value;await render(false);},refresh:render,notify:message=>{const notice=root.querySelector('#settingsNotice');notice.className='notice';notice.textContent=message;},onExport:async()=>downloadMatches((await accountRequest('/matches')).matches),onSync:()=>location.assign('/scouting/#settings'),onClear:()=>{throw new Error('Open scouting settings to manage schedules saved by this browser.');}});
}
render().catch(error=>{root.textContent=error.message;});
