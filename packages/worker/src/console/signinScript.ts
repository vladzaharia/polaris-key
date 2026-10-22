/**
 * The console sign-in card's one inline script (ST-30c.6; SIGN-IN.md §3.13 exception, plan D-S2).
 *
 * The card is script-free except for this: it reveals **Sign in with a passkey** (or **Use your
 * passkey** on a step-up) when the browser has WebAuthn, runs
 * `POST /manage/login/passkey/options` -> `navigator.credentials.get` -> `.../verify`, and
 * navigates to the `next` the Worker returns. With the email field it also arms conditional UI
 * (`autocomplete="username webauthn"`). Errors are written into `#pk-err` (a `role="alert"`
 * region) in house copy. Without JS or WebAuthn the block stays `hidden` and the card is the
 * plain form it was.
 *
 * The CSP names this source by hash (`SIGNIN_SCRIPT_HASH`), never `'unsafe-inline'`. The hash is a
 * literal so a change to the source cannot silently re-allow itself: `test/consoleCard.test.ts`
 * recomputes it from `SIGNIN_SCRIPT` and from the served page, and fails on any difference. To
 * update after an edit, run the sha256 of `SIGNIN_SCRIPT` (base64) and paste it below.
 *
 * No string here is interpolated from a request: the page passes the step-up flag and the
 * already-sanitised `returnTo` as data attributes on `#pk`.
 */

export const SIGNIN_SCRIPT = `(function(){
var box=document.getElementById("pk");
var pk=window.PublicKeyCredential;
if(!box||!pk||!navigator.credentials||!navigator.credentials.get)return;
var btn=document.getElementById("pk-go"),err=document.getElementById("pk-err");
var stepUp=box.getAttribute("data-step-up")==="1";
var back=box.getAttribute("data-return-to")||"";
var COPY={
method:"This passkey can\\u2019t open the console yet. Sign in with your account, then use it from Account \\u2192 Sign-in methods.",
idp_first:"Sign in with Pocket ID first. Your access needs a recent sign-in with your company account.",
no_grant:"This account has no access here. Ask a Superadmin to add you.",
account:"This account can\\u2019t sign in here. Ask a Superadmin for help.",
step_up_account:"Use a passkey of the account you\\u2019re signed in with.",
invalid:"That passkey didn\\u2019t work. Try again, or sign in with your account.",
expired:"This passkey request expired. Try again.",
rate:"Too many tries. Wait a minute, then try again.",
off:"Passkeys aren\\u2019t available here. Sign in with your account.",
other:"Something went wrong. Try again."
};
function bytes(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a.buffer}
function b64(buf){var a=new Uint8Array(buf),s="";for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}
function say(k){err.textContent=k?COPY[k]||COPY.other:""}
function post(path,body){return fetch(path,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{ok:r.ok,status:r.status,json:j||{}}})})}
function why(r){var j=r.json;if(r.status===429)return"rate";if(j.reason&&COPY[j.reason])return j.reason;if(j.error==="signin_expired")return"expired";if(r.status===401)return"invalid";if(r.status===404)return"off";return"other"}
function go(next){if(typeof next==="string"&&/^\\/(?![\\/\\\\])/.test(next))location.assign(next);else location.assign("/manage/")}
var ctl=null,busy=false;
function run(conditional){
if(ctl)ctl.abort();
var mine=ctl=new AbortController();
say("");
var start=back?{returnTo:back}:{};
if(stepUp)start.stepUp=true;
return post("/manage/login/passkey/options",start).then(function(o){
if(!o.ok||!o.json.options){say(why(o));return null}
var p=o.json.options;
var pub={challenge:bytes(p.challenge),rpId:p.rpId,timeout:p.timeout,userVerification:p.userVerification||"required",allowCredentials:(p.allowCredentials||[]).map(function(c){return{type:"public-key",id:bytes(c.id),transports:c.transports}})};
var ask={publicKey:pub,signal:mine.signal};
if(conditional)ask.mediation="conditional";
return navigator.credentials.get(ask).then(function(c){
if(!c)return null;
var r=c.response;
var res={id:c.id,rawId:b64(c.rawId),type:c.type,response:{clientDataJSON:b64(r.clientDataJSON),authenticatorData:b64(r.authenticatorData),signature:b64(r.signature)},clientExtensionResults:{}};
if(r.userHandle)res.response.userHandle=b64(r.userHandle);
return post("/manage/login/passkey/verify",{response:res}).then(function(v){
if(mine!==ctl)return null;
if(v.ok&&v.json.status==="signed_in"){go(v.json.next);return null}
say(why(v));
return"again"
})
},function(e){
if(mine!==ctl||(e&&e.name==="AbortError"))return null;
if(!conditional&&e&&e.name!=="NotAllowedError")say("other");
return null
})
},function(){if(mine===ctl)say("other");return null}).then(function(again){
if(again==="again"&&conditional&&mine===ctl)run(true)
})
}
btn.addEventListener("click",function(){
if(busy)return;
busy=true;btn.setAttribute("aria-busy","true");btn.setAttribute("aria-disabled","true");
run(false).then(function(){busy=false;btn.removeAttribute("aria-busy");btn.removeAttribute("aria-disabled")})
});
box.hidden=false;
var email=document.getElementById("email");
if(email&&!stepUp&&typeof pk.isConditionalMediationAvailable==="function")pk.isConditionalMediationAvailable().then(function(ok){if(ok)run(true)},function(){})
})();`;

/** `'sha256-…'` of `SIGNIN_SCRIPT` as the CSP names it; pinned by `test/consoleCard.test.ts`. */
export const SIGNIN_SCRIPT_HASH =
  "'sha256-Y3r3WcCx8b0EXJg0LtSlvqZD4/sWbY/ztvOOalJ9K9w='";
