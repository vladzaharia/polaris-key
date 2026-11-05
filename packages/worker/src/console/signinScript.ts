/**
 * The console sign-in card's one inline script (ST-30c.6; SIGN-IN.md §3.13 exception, plan D-S2).
 *
 * The card is script-free except for this: it reveals **Continue with a passkey** (or **Use your
 * passkey** on a step-up) when the browser has WebAuthn, shows the returning-person step (the
 * Locker hint step: "Welcome back", the usual way first) from what THIS browser remembers of its own
 * last sign-in, stashes how this tab is signing in for the SPA to remember (`lib/lastMethod.ts`), runs
 * `POST /manage/login/passkey/options` -> `navigator.credentials.get` -> `.../verify`, and
 * navigates to the `next` the Worker returns. With the email field it also arms conditional UI
 * (`autocomplete="username webauthn"`). Errors are written into `#pk-err` (a `role="alert"`
 * region) in house copy. Without JS or WebAuthn the block stays `hidden` and the card is the
 * plain form it was.
 *
 * The CSP names this source by hash (`SIGNIN_SCRIPT_HASH`), never `'unsafe-inline'`. The hash is a
 * literal so a change to the source cannot silently re-allow itself: `test/surfaces/console/consoleCard.test.ts`
 * recomputes it from `SIGNIN_SCRIPT` and from the served page, and fails on any difference. To
 * update after an edit, run the sha256 of `SIGNIN_SCRIPT` (base64) and paste it below.
 *
 * The script sits before the returning-person step in the document, so it waits for the parser
 * (`DOMContentLoaded`) before it looks for any element.
 *
 * The remembered record is `pk_console_last_method` = `kind.hash.at` (hash: the first 12 bytes of
 * SHA-256 of `salt:address`, the salt in localStorage); the same hash as `lib/lastMethod.ts`, pinned
 * by one shared test vector. It is read only here and compared in the browser: no request is made
 * and the server never sees the record. No string here is interpolated from a request: the page passes the step-up flag and the
 * already-sanitised `returnTo` as data attributes on `#pk`.
 */

export const SIGNIN_SCRIPT = `(function(){
function main(){
var box=document.getElementById("pk");
var pk=window.PublicKeyCredential;
if(!box||!pk||!navigator.credentials||!navigator.credentials.get)return;
var stepUp=box.getAttribute("data-step-up")==="1";
var back=box.getAttribute("data-return-to")||"";
var email=document.getElementById("email");
var form=email?email.form:box.nextElementSibling;
var VIA="pk-console-signin-via",SALT="pk-console-hint-salt",NAME="pk-console-hint-name:",CK="pk_console_last_method";
var COPY={
method:"This passkey doesn’t open the console yet. Use single sign-on, then choose Use for the console in Account → Sign-in methods.",
idp_first:"Your access needs a recent single sign-on. Use it this time.",
no_grant:"This account has no access here. Ask a Superadmin to add you.",
account:"This account can’t sign in here. Ask a Superadmin for help.",
step_up_account:"Use a passkey of the account you’re signed in with.",
invalid:"Your passkey didn’t work. Try again, or use another way.",
cancelled:"Your passkey wasn’t used. Try again, or use another way.",
expired:"This passkey request expired. Try again.",
rate:"Too many sign-in attempts. Wait a minute, then try again.",
off:"Passkeys aren’t available here. Use single sign-on.",
ended:"Your session ended. Sign in again.",
offline:"Can’t reach Polaris Key. Check your connection, then try again.",
other:"Something went wrong. Try again."
};
var views={main:{btn:document.getElementById("pk-go"),msg:document.getElementById("pk-msg")},hint:{btn:document.getElementById("h-go"),msg:document.getElementById("h-msg")}};
var cur="main";
function lab(v){return v.btn.querySelector("span")}
var idle={main:lab(views.main).textContent,hint:views.hint.btn?lab(views.hint).textContent:""};
function bytes(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a.buffer}
function b64(buf){var a=new Uint8Array(buf),s="";for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}
function say(k){var v=views[cur];if(!v.msg)return;v.msg.textContent=k?COPY[k]||COPY.other:"";v.msg.hidden=!k}
function busy(on,text){var v=views[cur];if(!v.btn)return;if(on){v.btn.setAttribute("aria-busy","true");v.btn.setAttribute("aria-disabled","true")}else{v.btn.removeAttribute("aria-busy");v.btn.removeAttribute("aria-disabled")}lab(v).textContent=text||idle[cur]}
function stash(k){try{sessionStorage.setItem(VIA,k)}catch(e){}}
function post(path,body){return fetch(path,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{ok:r.ok,status:r.status,json:j||{}}})},function(){return{ok:false,status:0,json:{}}})}
function why(r,first){var j=r.json;if(r.status===0)return"offline";if(r.status===429)return"rate";if(j.reason&&COPY[j.reason])return j.reason;if(j.error==="signin_expired")return"expired";if(r.status===401)return first?"ended":"invalid";if(r.status===404)return"off";return"other"}
function go(next){stash("passkey");if(typeof next==="string"&&/^\\/(?![\\/\\\\])/.test(next))location.assign(next);else location.assign("/manage/")}
var ctl=null,condOK=false;
function arm(){if(email&&!stepUp&&condOK&&cur==="main")run(true,true)}
function armOnFocus(){if(!email||stepUp||!condOK)return;email.addEventListener("focus",function f(){email.removeEventListener("focus",f);arm()})}
function run(conditional,keep){
if(ctl)ctl.abort();
var mine=ctl=new AbortController();
if(!keep)say("");
var start=back?{returnTo:back}:{};
if(stepUp)start.stepUp=true;
var quiet=conditional;
function note(k){if(!quiet)say(k)}
function stop(retry){if(mine!==ctl)return;if(!conditional)busy(false);if(retry==="now")arm();else if(retry==="focus")armOnFocus()}
return post("/manage/login/passkey/options",start).then(function(o){
if(mine!==ctl)return;
if(!o.ok||!o.json.options){note(why(o,true));stop("focus");return}
var p=o.json.options;
var pub={challenge:bytes(p.challenge),rpId:p.rpId,timeout:p.timeout,userVerification:p.userVerification||"required",allowCredentials:(p.allowCredentials||[]).map(function(c){return{type:"public-key",id:bytes(c.id),transports:c.transports}})};
var ask={publicKey:pub,signal:mine.signal};
if(conditional)ask.mediation="conditional";
return navigator.credentials.get(ask).then(function(c){
if(mine!==ctl)return;
if(!c){stop(conditional?"focus":"now");return}
quiet=false;
var r=c.response;
say("");busy(true,"Signing in…");
var res={id:c.id,rawId:b64(c.rawId),type:c.type,response:{clientDataJSON:b64(r.clientDataJSON),authenticatorData:b64(r.authenticatorData),signature:b64(r.signature)},clientExtensionResults:{}};
if(r.userHandle)res.response.userHandle=b64(r.userHandle);
return post("/manage/login/passkey/verify",{response:res}).then(function(v){
if(v.ok&&v.json.status==="signed_in"){go(v.json.next);return}
say(why(v,false));busy(false);stop("focus")
})
},function(e){
if(mine!==ctl||(e&&e.name==="AbortError"))return;
if(e&&e.name==="NotAllowedError"){note("cancelled");stop(conditional?"focus":"now")}
else{note("other");stop("focus")}
})
})
}
function press(){var v=views[cur];if(v.btn.getAttribute("aria-busy"))return;busy(true);run(false)}
views.main.btn.addEventListener("click",press);
var hint=document.getElementById("pk-hint"),mainEl=document.getElementById("pk-main"),hinted="";
function initHint(){
views.hint.btn.addEventListener("click",press);
var T0=document.title;
function show(h){document.title=h?"Welcome back · Polaris Key Console":T0;hint.hidden=!h;mainEl.hidden=h;cur=h?"hint":"main";if(h){if(ctl)ctl.abort();say("");var t=document.getElementById("h-title");t.focus()}else{say("");email.focus();email.select();arm()}}
function hex(buf){var a=new Uint8Array(buf),s="";for(var i=0;i<12;i++)s+=(a[i]<16?"0":"")+a[i].toString(16);return s}
function ago(t){var s=Math.round((t*1000-Date.now())/1000);if(Math.abs(s)<60)return"just now";var u=[["year",31536000],["month",2592000],["week",604800],["day",86400],["hour",3600],["minute",60]];try{var f=new Intl.RelativeTimeFormat("en",{numeric:"auto"});for(var i=0;i<u.length;i++)if(Math.abs(s)>=u[i][1])return f.format(Math.round(s/u[i][1]),u[i][0]);return f.format(0,"second")}catch(e){return"before"}}
function rec(){var m=document.cookie.split("; ").filter(function(c){return c.indexOf(CK+"=")===0})[0];if(!m)return null;var p=m.slice(CK.length+1).split(".");return p.length>=2&&p[0]==="passkey"?{h:p[1],at:Number(p[2])||0}:null}
function submitSso(){stash("sso");form.submit()}
function fill(addr,r){var n=null;try{n=localStorage.getItem(NAME+r.h)}catch(e){}
document.getElementById("h-email").textContent=addr;
document.getElementById("h-ini").textContent=(n||addr).charAt(0).toUpperCase()||"?";
document.getElementById("h-title").textContent=n?"Welcome back, "+n:"Welcome back";
var w=document.getElementById("h-when");var g=r.at?ago(r.at):"";if(g&&g!=="just now"){w.textContent="On this browser, last time "+g;w.hidden=false}else w.hidden=true}
form.addEventListener("submit",function(e){
var addr=email.value.trim(),r=rec();
if(!r||!addr||hinted===addr.toLowerCase()||!window.crypto||!crypto.subtle){stash("sso");return}
e.preventDefault();
var salt="";try{salt=localStorage.getItem(SALT)||""}catch(x){}
crypto.subtle.digest("SHA-256",new TextEncoder().encode(salt+":"+addr.toLowerCase())).then(function(d){
if(hex(d)===r.h){hinted=addr.toLowerCase();fill(addr,r);show(true)}else submitSso()
},submitSso)
});
document.getElementById("h-sso").addEventListener("click",submitSso);
document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!hint.hidden&&!e.defaultPrevented)show(false)});
document.getElementById("h-change").addEventListener("click",function(){show(false)});
document.getElementById("h-other").addEventListener("click",function(){show(false)});
}
if(hint&&mainEl&&email&&form&&!stepUp&&views.hint.btn)initHint();
else if(form)form.addEventListener("submit",function(){stash("sso")});
box.hidden=false;
if(email&&!stepUp&&typeof pk.isConditionalMediationAvailable==="function")pk.isConditionalMediationAvailable().then(function(ok){condOK=ok===true;arm()},function(){})
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",main);else main()
})();`;

/** `'sha256-…'` of `SIGNIN_SCRIPT` as the CSP names it; pinned by `test/surfaces/console/consoleCard.test.ts`. */
export const SIGNIN_SCRIPT_HASH =
  "'sha256-4Lp8n0tsefGCRQWuN5PFQEsL7qOjpXSLU9AFK0M94lc='";
