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
 * literal so a change to the source cannot silently re-allow itself: `test/surfaces/console/consoleCard.test.ts`
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
var btn=document.getElementById("pk-go"),lab=document.getElementById("pk-label");
var msg=document.getElementById("pk-msg"),msgT=document.getElementById("pk-msg-t");
var stepUp=box.getAttribute("data-step-up")==="1";
var back=box.getAttribute("data-return-to")||"";
var email=document.getElementById("email");
var via=stepUp?"Sign in again":"Continue";
var idle=lab.textContent;
var COPY={
method:"This passkey doesn’t open the console yet. Use "+via+", then choose Use for the console in Account → Sign-in methods.",
idp_first:"Your access needs a recent company sign-in. Use "+via+" this time.",
no_grant:"This account has no access here. Ask a Superadmin to add you.",
account:"This account can’t sign in here. Ask a Superadmin for help.",
step_up_account:"Use a passkey of the account you’re signed in with.",
invalid:"That passkey didn’t work. Try again, or use "+via+".",
expired:"This passkey request expired. Try again.",
rate:"Too many sign-in attempts. Wait a minute, then try again.",
off:"Passkeys aren’t available here. Use "+via+".",
ended:"Your session ended. Sign in again.",
offline:"Can’t reach Polaris Key. Check your connection, then try again.",
other:"Something went wrong. Try again."
};
function bytes(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a.buffer}
function b64(buf){var a=new Uint8Array(buf),s="";for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}
function say(k){msgT.textContent=k?COPY[k]||COPY.other:"";msg.hidden=!k}
function busy(on,text){if(on){btn.setAttribute("aria-busy","true");btn.setAttribute("aria-disabled","true")}else{btn.removeAttribute("aria-busy");btn.removeAttribute("aria-disabled")}lab.textContent=text||idle}
function post(path,body){return fetch(path,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{ok:r.ok,status:r.status,json:j||{}}})},function(){return{ok:false,status:0,json:{}}})}
function why(r,first){var j=r.json;if(r.status===0)return"offline";if(r.status===429)return"rate";if(j.reason&&COPY[j.reason])return j.reason;if(j.error==="signin_expired")return"expired";if(r.status===401)return first?"ended":"invalid";if(r.status===404)return"off";return"other"}
function go(next){if(typeof next==="string"&&/^\\/(?![\\/\\\\])/.test(next))location.assign(next);else location.assign("/manage/")}
var ctl=null,condOK=false;
function arm(){if(email&&!stepUp&&condOK)run(true,true)}
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
if(e&&e.name==="NotAllowedError")stop(conditional?"focus":"now");
else{note("other");stop("focus")}
})
})
}
btn.addEventListener("click",function(){
if(btn.getAttribute("aria-busy"))return;
busy(true);
run(false)
});
box.hidden=false;
if(email&&!stepUp&&typeof pk.isConditionalMediationAvailable==="function")pk.isConditionalMediationAvailable().then(function(ok){condOK=ok===true;arm()},function(){})
})();`;

/** `'sha256-…'` of `SIGNIN_SCRIPT` as the CSP names it; pinned by `test/surfaces/console/consoleCard.test.ts`. */
export const SIGNIN_SCRIPT_HASH =
  "'sha256-4szpK1kVqxpZ38+0S242KDV0DBmNMt6TcruG4RXRww4='";
