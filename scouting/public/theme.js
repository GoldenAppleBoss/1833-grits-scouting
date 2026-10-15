(() => {
  const key='team1833-appearance-v1';
  const normalize=value=>({theme:['light','dark','bean'].includes(value?.theme)?value.theme:'bean',reduceMotion:value?.reduceMotion===true});
  function read(){try{return normalize(JSON.parse(localStorage.getItem(key)||'null'));}catch{return normalize(null);}}
  function apply(value,persist=true){const settings=normalize(value);document.documentElement.dataset.theme=settings.theme;document.documentElement.dataset.reduceMotion=String(settings.reduceMotion);if(persist){try{localStorage.setItem(key,JSON.stringify(settings));}catch{/* Appearance still applies if storage is unavailable. */}}return settings;}
  window.Team1833Appearance={read,apply,hasLocal(){try{return Boolean(localStorage.getItem(key));}catch{return false;}}};
  apply(read(),false);
})();
