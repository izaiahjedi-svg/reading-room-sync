function getDefaultProfileSettings(){
  return { font:'Georgia, "Iowan Old Style", serif', fontSize:19, lineHeight:1.7, theme:'dark' };
}

function getDefaultProfiles(){
  return {
    izaiah: { name:'Izaiah', settings:getDefaultProfileSettings() },
    andrew: { name:'Andrew', settings:getDefaultProfileSettings() },
    david: { name:'David', settings:getDefaultProfileSettings() }
  };
}

const ACTIVE_PROFILE_STORAGE_KEY = 'reading-room:active-profile-id';

function getStoredActiveProfileId(){
  try { return (window.localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY) || '').trim().toLowerCase(); }
  catch (e) { return ''; }
}

function storeActiveProfileId(profileId){
  try {
    if (profileId) window.localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, profileId);
    else window.localStorage.removeItem(ACTIVE_PROFILE_STORAGE_KEY);
  } catch (e) {}
}
