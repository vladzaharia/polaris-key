from pathlib import Path
import io,json,shutil,hashlib,zipfile,html
import cairosvg
from PIL import Image,ImageDraw,ImageFont
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont as RLFont
from reportlab.lib.colors import HexColor
from svglib.svglib import svg2rlg
from reportlab.graphics import renderPDF
from pypdf import PdfReader,PdfWriter
ROOT=Path(__file__).resolve().parents[1]; OUT=ROOT.parent
for d in ['logos/svg','logos/png','logos/pdf','icons/png','icons/platform','badges','social','tokens','fonts','docs','previews','web']:(ROOT/d).mkdir(parents=True,exist_ok=True)
fontsrc=ROOT/'fonts/Rubik-Variable.ttf'
if not fontsrc.exists():shutil.copy('Rubik.ttf',fontsrc);shutil.copy('Rubik-OFL.txt',ROOT/'fonts/OFL.txt')
fonts={}
for w in [400,500,600]:
 p=ROOT/f'fonts/Rubik-{w}.ttf'; f=instantiateVariableFont(TTFont(fontsrc),{'wght':w},inplace=False)
 # Distinct PostScript identities prevent PDF font caches from collapsing weights.
 style={400:'Regular',500:'Medium',600:'SemiBold'}[w]
 for record in list(f['name'].names):
  value={1:'Rubik',2:style,4:'Rubik '+style,6:'Rubik-'+style,16:'Rubik',17:style}.get(record.nameID)
  if value:f['name'].setName(value,record.nameID,record.platformID,record.platEncID,record.langID)
 f.save(p);fonts[w]=f;pdfmetrics.registerFont(RLFont('R'+str(w),str(p)))
exec((ROOT/'source/family_system.py').read_text(),globals())
write_family_files(ROOT)
DARK=FAMILY_DARK['page'];LIGHT=FAMILY_LIGHT['page'];CORAL=BRANDS['locker']['darkAccent'];DEEP=BRANDS['locker']['lightAccent'];BODY=FAMILY_DARK['text'];MUTED=FAMILY_DARK['muted']
def textpath(s,x,y,size,color,w=500):
 f=fonts[w];gs=f.getGlyphSet();cm=f.getBestCmap();upm=f['head'].unitsPerEm;pen=SVGPathPen(gs);pos=0;out=[]
 for ch in s:
  gn=cm[ord(ch)];p=SVGPathPen(gs);gs[gn].draw(p);out.append(f'<path transform="translate({pos},0)" d="{p.getCommands()}"/>');pos+=gs[gn].width
 return f'<g fill="{color}" transform="translate({x},{y}) scale({size/upm}, {-size/upm})">'+''.join(out)+'</g>',pos*size/upm
def glyph(ink=CORAL,star='#ffffff',cut='master'):
 if cut=='micro':
  return f'<g transform="scale(8)"><path fill="{ink}" d="M1 6 L4.5 3 H5 V11 H8 V13 H1 Z M9 11 L13 8 H15 V13 H9 Z"/><path fill="{star}" d="M9.5 5 L10.3 6.7 L12 7.5 L10.3 8.3 L9.5 10 L8.7 8.3 L7 7.5 L8.7 6.7 Z"/></g>'
 # A2: compact left bookend, open centre, separate rising right bookend.
 return f'<path fill="{ink}" d="M8 49 Q8 47 10 45 L35 25 Q37 23 40 24 Q42 25 42 28 V85 H61 Q64 85 64 88 V102 H12 Q8 102 8 98 Z M73 84 L101 61 Q103 59 106 59 H116 Q120 59 120 63 V98 Q120 102 116 102 H76 Q72 102 72 98 V87 Q72 85 73 84 Z"/><path fill="{star}" d="M74 41 Q75 41 75.5 43 L79.7 52.3 L89 56.5 Q91 57.5 89 58.5 L79.7 62.7 L75.5 72 Q74.5 74 73.5 72 L69.3 62.7 L60 58.5 Q58 57.5 60 56.5 L69.3 52.3 L73.5 43 Q74 41 74 41 Z"/>'
def svg(body,w=128,h=128,bg=None):
 return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-label="Polaris Locker">'+(f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else '')+body+'</svg>'
def save_svg(path,s,pngsizes=(),pdf=False):
 p=ROOT/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(s)
 for size in pngsizes:cairosvg.svg2png(bytestring=s.encode(),write_to=str(p.with_name(p.stem+f'-{size}.png')),output_width=size)
 if pdf:cairosvg.svg2pdf(bytestring=s.encode(),write_to=str(p.with_suffix('.pdf')))
def png(s,path,size):cairosvg.svg2png(bytestring=s.encode(),write_to=str(path),output_width=size)
themes={'dark':(CORAL,'#ffffff',BODY),'light':(DEEP,DEEP,'#262d40'),'white':('#ffffff','#ffffff','#ffffff'),'black':('#000000','#000000','#000000'),'coral':(CORAL,CORAL,CORAL)}
for name,(ink,st,txt) in themes.items():
 for cut in ['master','micro']:
  s=svg(glyph(ink,st,cut));save_svg(f'logos/svg/locker-mark-{name}-{cut}.svg',s)
  for size in ([16,20] if cut=='micro' else [24,32,48,64,96,128,256,512,1024,2048]):png(s,ROOT/f'logos/png/locker-mark-{name}-{size}.png',size)
  cairosvg.svg2pdf(bytestring=s.encode(),write_to=str(ROOT/f'logos/pdf/locker-mark-{name}-{cut}.pdf'))
 for kind in ['horizontal','stacked','compact']:
  if kind=='horizontal':
   t,tw=textpath('Polaris Locker',144,80,44,txt);s=svg(glyph(ink,st)+t,round(160+tw),128)
  elif kind=='compact':
   a,aw=textpath('Polaris',144,57,32,txt);b,bw=textpath('Locker',144,96,32,txt);s=svg(glyph(ink,st)+a+b,round(160+max(aw,bw)),128)
  else:
   t,tw=textpath('Polaris Locker',0,0,32,txt);s=svg(f'<g transform="translate({(320-128)/2},0)">'+glyph(ink,st)+f'</g><g transform="translate({(320-tw)/2},165)">'+t+'</g>',320,192)
  save_svg(f'logos/svg/locker-{kind}-{name}.svg',s)
  for width in [320,640,1280,2560]:png(s,ROOT/f'logos/png/locker-{kind}-{name}-{width}.png',width)
  cairosvg.svg2pdf(bytestring=s.encode(),write_to=str(ROOT/f'logos/pdf/locker-{kind}-{name}.pdf'))
save_svg('logos/svg/locker-mark-currentColor.svg',svg(glyph('currentColor','currentColor')))
# Background-owned icon exports. Foreground remains within the centre safe area.
for theme,bg in [('dark',DARK),('light',LIGHT),('coral',CORAL)]:
 ink,st,_=themes['light' if theme=='light' else 'dark'];ink,st=(DARK,DARK) if theme=='coral' else (ink,st)
 for n in [16,20,24,32,40,48,64,96,128,180,192,256,512,1024]:
  body=glyph(ink,st,'micro' if n<24 else 'master');s=svg(body if n<24 else f'<g transform="translate(12.8,12.8) scale(.8)">{body}</g>',bg=bg);png(s,ROOT/f'icons/png/locker-app-{theme}-{n}.png',n)
 save_svg(f'icons/platform/locker-app-{theme}.svg',s)
for theme in ['dark','light']:
 im=Image.open(ROOT/f'icons/png/locker-app-{theme}-256.png');im.save(ROOT/f'icons/platform/locker-{theme}.ico',sizes=[(n,n) for n in [16,24,32,48,64,128,256]],append_images=[Image.open(ROOT/f'icons/png/locker-app-{theme}-{n}.png') for n in [16,24,32,48,64,128]])
Image.open(ROOT/'icons/png/locker-app-dark-1024.png').save(ROOT/'icons/platform/locker.icns')
shutil.copy(ROOT/'icons/png/locker-app-dark-180.png',ROOT/'web/apple-touch-icon.png');shutil.copy(ROOT/'icons/platform/locker-dark.ico',ROOT/'web/favicon.ico')
# Browser favicon uses true micro geometry and theme-aware fills.
fav=svg('<style>.body{fill:#ff7869}.star{fill:white}@media(prefers-color-scheme:light){.body,.star{fill:#c44438}}</style>'+glyph().replace(f'fill="{CORAL}"','class="body"').replace('fill="#ffffff"','class="star"'))
# Dedicated micro source rather than automatic shrink of display master.
fav=svg('<style>.body{fill:#ff7869}.star{fill:white}@media(prefers-color-scheme:light){.body,.star{fill:#c44438}}</style>'+glyph(cut='micro').replace(f'fill="{CORAL}"','class="body"').replace('fill="#ffffff"','class="star"'))
save_svg('web/favicon.svg',fav)
for n in [192,512]:shutil.copy(ROOT/f'icons/png/locker-app-dark-{n}.png',ROOT/f'web/icon-{n}.png')
mask=svg('<g transform="translate(25.6,25.6) scale(.6)">'+glyph()+'</g>',bg=DARK);save_svg('web/maskable.svg',mask);png(mask,ROOT/'web/maskable-512.png',512)
(ROOT/'web/site.webmanifest').write_text(json.dumps({'name':'Polaris Locker','short_name':'Locker','start_url':'./','display':'standalone','background_color':DARK,'theme_color':DARK,'icons':[{'src':f'icon-{n}.png','sizes':f'{n}x{n}','type':'image/png','purpose':'any'} for n in [192,512]]+[{'src':'maskable-512.png','sizes':'512x512','type':'image/png','purpose':'maskable'}]},indent=2))
BADGES = [('Powered by','powered-by'),('Available on','available-on'),('Available in','available-in'),('Open in','open-in'),('Get it on','get-it-on'),('Download from','download-from'),('Install with','install-with'),('Play on','play-on'),('Purchase with','purchase-with'),('Buy on','buy-on'),('Login with','login-with'),('Sign in with','sign-in-with'),('Connect with','connect-with'),('Manage with','manage-with'),('Sync with','sync-with'),('Update with','update-with')]
for phrase,slug in BADGES:
 for theme in ['dark','light','white']:
  ink,st,txt=themes[theme]
  for style in ['transparent','sticker','outline']:
   bg=None if style=='transparent' else (LIGHT if theme=='light' else DARK)
   body=''
   if bg:body=f'<rect x="1" y="1" width="318" height="102" rx="18" fill="{bg}" stroke="{txt if style=="outline" else bg}" stroke-width="2"/>'
   body+='<g transform="translate(16,20) scale(.5)">'+glyph(ink,st)+'</g>'
   body+=textpath(phrase,96,42,14,txt,400)[0]+textpath('Polaris Locker',96,72,24,txt,500)[0]
   s=svg(body,320,104).replace('aria-label="Polaris Locker"',f'aria-label="{phrase} Polaris Locker"');save_svg(f'badges/locker-{slug}-{theme}-{style}.svg',s,pngsizes=[320,640,1280],pdf=True)
# Social templates, ready to publish; no invented product or availability claims.
for name,w,h in [('social-square',1080,1080),('social-landscape',1200,630),('social-portrait',1080,1350)]:
 body=f'<g transform="translate(72,64) scale(1.8)">{glyph()}</g>'
 body+=textpath('Polaris Locker',72,h*.58,72,BODY,600)[0]+textpath('A home for your software.',72,h*.58+68,30,MUTED,400)[0]
 body+=textpath('Build / Discover / Grow',72,h-64,20,CORAL,400)[0]
 s=svg(body,w,h,DARK);save_svg(f'social/{name}.svg',s,pngsizes=[w])
# Tokens use deeper coral for light foreground, preserving selected bright coral on dark.
tokens={'version':'1.3.0','brand':'Polaris Locker','concept':'A2 compact bookends','architecture':{'publicBrand':'Polaris Locker','underlyingPlatform':'Polaris Key','attribution':'Powered by Polaris Locker'},'dark':dict(FAMILY_DARK,accent=CORAL,onAccent=DARK),'light':dict(FAMILY_LIGHT,accent=DEEP,onAccent='#ffffff'),'font':FAMILY_FONTS,'sharedSpecification':'polaris-family.tokens.json','clearSpace':'one quarter of visible glyph height','opticalCut':{'micro':'16-23 CSS px','master':'24 CSS px and above'}}
(ROOT/'tokens/locker.tokens.json').write_text(json.dumps(tokens,indent=2))
(ROOT/'tokens/locker.css').write_text(':root {\n'+''.join(f'  --locker-{k}: {v};\n' for k,v in tokens['dark'].items())+'  --locker-font: Rubik, system-ui, sans-serif;\n}\n[data-theme="light"] {\n'+''.join(f'  --locker-{k}: {v};\n' for k,v in tokens['light'].items())+'}\n')
def luminance(h):
 a=[int(h[i:i+2],16)/255 for i in [1,3,5]];a=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in a];return sum(x*y for x,y in zip(a,[.2126,.7152,.0722]))
def contrast(a,b):
 x,y=sorted([luminance(a),luminance(b)]);return (y+.05)/(x+.05)
contrastrows=[('Coral / dark',CORAL,DARK),('Deep coral / light',DEEP,LIGHT),('White / deep coral','#ffffff',DEEP),('Dark / coral',DARK,CORAL),('Body / dark',BODY,DARK)]
# Guides: vector artwork and selectable embedded Rubik text.
W,H=900,640
class Guide:
 def __init__(self,path,title):self.c=canvas.Canvas(str(path),pagesize=(W,H));self.c.setTitle(title);self.c.setAuthor('Polaris');self.i=0;self.title=title
 def page(self,kicker,title,lead=''):
  c=self.c;self.i+=1;c.bookmarkPage(str(self.i));c.addOutlineEntry(title,str(self.i),0,False);c.setFillColor(HexColor(DARK));c.rect(0,0,W,H,fill=1,stroke=0);self.text(44,600,getattr(self,'masthead','Polaris Locker'),15,500);self.text(600,600,kicker.upper(),10,400,MUTED);c.setStrokeColor(HexColor('#303846'));c.line(44,581,856,581);self.text(44,526,title,34,600)
  if lead:self.para(44,492,lead,760,14)
  self.text(44,27,getattr(self,'footer','POLARIS LOCKER / V1.3 / 19 OCTOBER 2026'),9,400,MUTED);self.text(814,27,f'{self.i:02}',10,400,MUTED)
 def text(self,x,y,t,size=14,weight=400,color=BODY):self.c.setFillColor(HexColor(color));self.c.setFont('R'+str(weight),size);self.c.drawString(x,y,t)
 def para(self,x,y,t,width=365,size=14,color=BODY):
  line=''
  for word in t.split():
   test=(line+' '+word).strip()
   if pdfmetrics.stringWidth(test,'R400',size)>width:self.text(x,y,line,size,400,color);y-=size*1.5;line=word
   else:line=test
  if line:self.text(x,y,line,size,400,color)
  return y-size*1.7
 def block(self,x,y,title,body,width=365):self.text(x,y,title,19,500,CORAL);return self.para(x,y-30,body,width)
 def art(self,s,x,y,w,h=None):
  d=svg2rlg(io.BytesIO(s.encode()));scale=w/d.width;d.scale(scale,scale);renderPDF.draw(d,self.c,x,y)
 def end(self):self.c.showPage()
 def save(self):self.c.save()
 def bullets(self,items,y=430):
  for title,body in items:y=self.block(44,y,title,body,780)-24
G=Guide(OUT/'Polaris-Locker-Brand-Guide-v1.pdf','Polaris Locker - Brand Guide v1')
G.page('Brand guide','One public name.','Polaris Locker is the identity on every public-facing surface.');G.art(svg(glyph()),90,120,300);G.block(440,330,'Compact Bookends / A2','Coral Bookends identifies Polaris Locker across marketing, product, developer and partner experiences. The underlying platform is Polaris Key.');G.text(440,175,'Identity system / Edition 01.3',16,500);G.end()
G.page('Contents','Start with the right reference.');G.bullets([('03-05 / Identity','Positioning, architecture and the approved master.'),('06-10 / Foundations','Optical sizing, clear space, lockups, colour and typography.'),('11-15 / Expression','Composition, public surfaces, voice, motion and attribution.'),('16-20 / Delivery and alignment','Asset selection, governance, shared foundations and capability colours.')]);G.end()
G.page('03 / Positioning','A home for your software.','One public identity for builders, customers and partners.');G.bullets([('Purpose','Polaris Locker is the public name for the platform and its experiences, from developer tools and docs to discovery, library and account. Polaris Key supplies the underlying technical infrastructure.'),('Personality','Welcoming, capable and clear. Help people build, find, access and manage software with useful actions and honest product claims.'),('Language','Use Polaris Locker on first mention and Locker when context is established. Name the surface by its job: Docs, Console, Library, Discover or Account. Key may be named in technical explanations; it is not a second public brand.')]);G.end()
G.page('04 / Architecture','Locker outside. Key underneath.');G.bullets([('Public identity / Polaris Locker','Use coral Bookends and the Locker name on marketing, public docs, console, authentication, downloads, emails, SDK presentation and integration badges.'),('Underlying platform / Polaris Key','Key remains a distinct platform brand with its own guide, Pinned K, Star Cut, colours and service identities. Locker is the identity used on public-facing product surfaces. The guide preserves Key’s brand rather than reducing it to an implementation label.'),('Capabilities','License, Config, Release, Distribution, Update, Identity, Cloud Sync, Commerce and Content Packs appear as capabilities within Locker. Their service semantics do not change.'),('Customer products','Host product names and artwork still lead in host-owned experiences. Any Polaris attribution uses Polaris Locker. This rule does not rename customers’ products.')]);G.end()
G.page('05 / Master','The star stays open.','The supplied vectors are the production interpretation of selected concept A2.');G.art(svg(glyph()),65,135,315);G.block(465,380,'Three independent shapes','A tall left bookend, a shorter rising right bookend and one four-point star. Preserve the asymmetry, softened corners and clear gaps.');G.block(465,230,'Always use the master','Use the supplied SVG, outlined lockup or exported PNG. Never trace the concept image, rebuild the star, or create a new shelf arrangement.');G.end()
G.page('06 / Optical sizing','Small is a separate drawing.','Choose the cut by displayed size, not by export resolution or device pixel ratio.');
for i,n in enumerate([16,24,32,48,96]):
 x=55+i*160;G.art(svg(glyph(cut='micro' if n<24 else 'master')),x,315,n);G.text(x,285,f'{n}px',13)
G.block(44,210,'16-23px / Micro','Use the dedicated micro source for browser favicons and editor integrations. Simplified corners and a wider star preserve the three-part reading.');G.block(470,210,'24px and above / Master','The master supports service-size, navigation and display use. All cuts are flat; Locker has no signing bit or gradient.');G.end()
G.page('07 / Clear space','Give the mark room.');G.art(svg(glyph()),65,190,300);G.block(465,400,'Minimum clearance','Reserve at least one quarter of the visible glyph height around standalone marks and lockups. Background containers can be closer only in the supplied app-icon and badge canvases.');G.block(465,245,'Minimum use','Standalone mark: 24 CSS px square; micro exception: 16px. Horizontal lockup: 180px wide. Compact: 120px wide. Stacked: 160px wide. For crowded navigation, choose the mark with an accessible label.');G.end()
G.page('08 / Lockups','One name. Flexible proportions.');
for name,y,w in [('horizontal',350,490),('compact',190,260),('stacked',65,220)]:G.art((ROOT/f'logos/svg/locker-{name}-dark.svg').read_text(),60,y,w);G.text(600,y+45,name.capitalize(),16,500)
G.end()
G.page('09 / Colour','Coral identifies the public brand.','Use bright coral on dark; use the deeper companion on light for useful contrast.');
for i,(name,a,b) in enumerate(contrastrows):
 y=421-i*56;G.c.setFillColor(HexColor(a));G.c.roundRect(44,y-10,54,32,5,fill=1,stroke=0);G.text(120,y,name,16,500);G.text(440,y,a.upper(),14);G.text(640,y,f'{contrast(a,b):.2f}:1',14)
G.para(44,102,'Ratios are computed from the flat sRGB pairs shown. Bright coral is not the light-theme body-text colour. Gold remains a signature-status indicator; coral is never a success, warning or payment state by itself.',780,13);G.end()
G.page('10 / Typography','Friendly, with a clear hierarchy.');G.text(44,415,'Your library',58,600);G.text(46,365,'Find something worth opening.',26,400,MUTED);G.bullets([('Rubik / 400, 500, 600','400 body and badge prefixes; 500 controls and wordmarks; 600 headings. Avoid universal boldness.'),('Product rhythm','Body 16-18px, labels 14-16px, section titles 24-32px. Let long names wrap. Use 1.6-1.75 line height for reading copy, as in Key.'),('Technical details','Use the parent system’s JetBrains Mono for diagnostic details only. The pack includes Rubik and its OFL notice; outlined logos need no installed font.')],y=290);G.end()
G.page('11 / Composition','Let the products lead.');G.bullets([('Page structure','Use shared grounds and neutrals. Coral identifies the Locker shell. Capability panels retain the Key service accents; use one accent per story.'),('Collection cards','Prioritize real product artwork and title, then access and a useful action. Device capacity and license detail support the decision.'),('Layout','Use a 4px spacing base and 24px section gutters for Locker product layouts. Match Key’s generous vertical rhythm. Keep 44px primary targets and visible focus.'),('Imagery','Use authentic product art. When absent, use a solid-colour placeholder and initials. Do not invent product artwork or claim a product is available.')]);G.end()
G.page('12 / Journeys','Every public surface uses Locker.');G.bullets([('Marketing and developer surfaces','Website, pricing, campaigns, docs, developer console, SDK landing pages and repository presentation use Locker names and artwork. Preserve executable identifiers in code examples.'),('Product and account','Library, Discover, downloads, sign-in, consent, device authorization, recovery and account use Locker. Retain truthful owned, available and purchasable states.'),('Communications and integrations','Support, notifications, email sender display names, social profiles and public badges use Locker. Show Powered by Polaris Locker for attribution.'),('Host-owned experiences','Keep the host product and identity provider recognizable. Apply Locker to the Polaris-provided identity or attribution, not to the customer’s own product brand.')]);G.end()
G.page('13 / Voice','Make the next step obvious.');G.bullets([('Empty library','“Your library starts here.” Follow with the actual available action; avoid implying a store exists before it ships.'),('Offline','“You’re offline. Try again when you’re connected.” Preserve any usable local state; do not promise offline downloads or sign-in.'),('Recovery','“We couldn’t start this download. Try again.” Add a specific recovery step when known.'),('Action language','Prefer Open, Download, View details and Manage devices. Describe the user-visible outcome, not the internal service or transaction.')]);G.end()
G.page('14 / Motion','Hold the star still.');G.bullets([('Identity','Keep the star stationary. A one-time subtle reveal of the bookends can introduce the brand; avoid spinning, bouncing or perpetual logo animation.'),('Product','Inherit Key’s motion system: about 80ms press feedback, 200-260ms navigation and 320-480ms entrance. Runtime tokens govern timing. Progress reflects actual state.'),('Reduced motion','Remove spatial movement and decorative loops. Maintain focus and scroll position; communicate changes with text and state.'),('Interaction','Aim for 44px primary touch targets, visible keyboard focus and non-colour state cues. Check zoom, narrow screens and long translated strings.')]);G.end()
G.page('15 / Attribution','A badge for the action.');G.art((ROOT/'badges/locker-powered-by-dark-outline.svg').read_text(),44,290,380);G.art((ROOT/'badges/locker-powered-by-light-sticker.svg').read_text(),465,290,380);G.block(44,230,'Public attribution','The library includes 16 labels: availability, play, purchase, login, downloads, installation, account, sync, updates and attribution. Canvas and minimum display: 320 x 104. Keep the vertical padding and Rubik 400 prefixes. See the badge catalogue for every option.');G.block(465,230,'Technical explanation','Match the label to the real action. Play on needs a playable destination; Purchase with needs a purchase flow; Login with needs an authentication flow. Key retains its platform-brand assets and guide. Public-facing Polaris attribution uses Locker.');G.end()
G.page('16 / Misuse','Protect the open silhouette.');G.bullets([('Do not reshape','Never stretch, rotate, crop, mirror, close the gap, remove the star or make the bookends symmetrical.'),('Do not decorate','No bevel, texture, outline treatment, shadow or gradient on the mark. Do not add gold, a lock, keyhole or signing bit.'),('Do not recolour arbitrarily','Use supplied theme variants. Mono means one ink across all three shapes. Keep coral distinct from the parent’s service palette.'),('Do not overclaim','Artwork does not certify security, ownership, availability or performance. Product and trust states require their own labels and evidence.')]);G.end()
G.page('17 / Asset selection','Pick the file that fits.');G.bullets([('logos / SVG, PNG, PDF','Transparent marks and three outlined lockups in dark, light, white, black and coral. SVG is preferred for interfaces; PDF for vector placement in print.'),('icons + web','Square icon canvases, ICO, ICNS, dedicated micro favicon, touch icon and a sample web manifest. The maskable export has extra safe area.'),('badges + social','Transparent, sticker and outline badges; square, landscape and portrait campaign canvases. Confirm destination and copy before publishing.'),('tokens + source','Shared family and Locker CSS / JSON roles; Rubik fonts and OFL notice; reproducible Python generator. Platform-specific submission requirements remain the responsibility of each release.')]);G.end()
G.page('18 / Governance','One rule across every channel.');G.bullets([('Authority','The 19 October 2026 public-brand update supersedes the earlier consumer-only scope. A2 geometry and coral remain approved. Locker covers all public surfaces; Key is the underlying platform.'),('Adoption','Integrate public Locker artwork and labels into packages/brand and docs/design/BRAND.md. Review web, console, docs, authentication, emails, downloads, SDKs and partner attribution.'),('Technical stability','This naming decision does not rename API fields, service slugs, packages, commands, repositories, domains or legal entities. Any such migration requires its own compatibility work.'),('Release checks','Inspect both themes and mono at 16, 24, 32, 48 and 96px. Verify correct public naming, labels, contrast, focus and product states. These guides do not claim deployment to live surfaces.')]);G.end()
exec((ROOT/'source/family_guide_pages.py').read_text(),globals())
G.save()
# Current platform reference and concise architecture amendment.
exec((ROOT/'source/platform_guide.py').read_text(),globals())
exec((ROOT/'source/badge_catalogue.py').read_text(),globals())
for f in ['Polaris-Locker-Brand-Guide-v1.pdf','Polaris-Key-Brand-Guide-Locker-Addendum-v1.pdf','Polaris-Key-Brand-Guide-with-Locker-v1.pdf','Polaris-Locker-Badge-Catalogue-v1.pdf']:shutil.copy(OUT/f,ROOT/'docs'/f)
# QA contact sheet uses actual raster exports at native and 4x nearest-neighbour scale.
qa=Image.new('RGB',(1120,720),DARK);draw=ImageDraw.Draw(qa);pf=ImageFont.truetype(str(ROOT/'fonts/Rubik-400.ttf'),18)
for row,(theme,bg) in enumerate([('dark',DARK),('light',LIGHT),('white',DARK),('black',LIGHT)]):
 y=row*180;draw.rectangle((0,y,1120,y+180),fill=bg);fg='white' if bg==DARK else 'black';draw.text((15,y+12),theme,fill=fg,font=pf)
 for col,n in enumerate([16,24,32,48,96]):
  im=Image.open(ROOT/f'logos/png/locker-mark-{theme}-{n}.png');x=140+col*190;qa.paste(im,(x,y+28),im);draw.text((x,y+140),str(n)+'px',fill=fg,font=pf)
qa.save(ROOT/'previews/size-theme-check.png')
# A large cover preview.
preview=svg('<g transform="translate(90,110) scale(2.8)">'+glyph()+'</g>'+textpath('Polaris Locker',500,300,60,BODY,600)[0]+textpath('Compact Bookends / Coral / v1.3',500,355,24,MUTED,400)[0],1200,630,DARK);png(preview,ROOT/'previews/identity.png',1200)
(ROOT/'web/README.md').write_text('Use favicon.svg with rel="icon" type="image/svg+xml"; favicon.ico as fallback; apple-touch-icon.png for touch devices. Link site.webmanifest after setting the final start_url, scope and deployment paths. Serve assets with correct MIME types. maskable-512.png has additional safe area.\n')
(ROOT/'README.md').write_text('''# Polaris Locker / Launch Kit v1.3

Approved direction: A2 Compact Bookends in coral. Date: 19 October 2026.

Start with docs/Polaris-Locker-Brand-Guide-v1.pdf. The Key guide retains the original 35 pages and its own prominent platform identity. A three-page Locker section follows the existing service pages and explains the public-facing distinction and shared design rules. Revision 1.3 aligns both guides through one family specification, retains all approved marks, and includes 16 badge labels. See the badge catalogue for artwork and usage.

## Use
- Use logos/svg for sharp interfaces and logos/pdf for vector placement.
- Names dark/light identify intended background. White/black/coral are one-ink variants.
- Use the micro source below 24 CSS px. All 16px and 20px mark exports use it.
- Lockups are outlined Rubik: no font dependency. PNGs are transparent unless explicitly app/social/sticker assets.
- Square app icons intentionally have no baked-in platform corner mask. Apply platform masks at integration time.
- The ICO contains an explicit micro 16px layer. ICNS and web assets are included.
- badges retain generous vertical padding and regular-weight prefixes. Never crop their canvas.
- “Available on” needs real availability; “Open in” needs a real destination.
- Public-facing attribution uses Polaris Locker. Polaris Key retains its own brand, marks and original guide; the Locker section explains where to use each identity.

## Public brand architecture
All public-facing surfaces use Polaris Locker: marketing, docs, console, sign-in, downloads, emails, SDK presentation and partner badges. Polaris Key is the underlying platform. Technical identifiers and host-owned brands are preserved. This pack does not deploy or rename live systems.

## Implementation
Start with docs/brand-alignment.md and tokens/polaris-family.tokens.json. Import tokens/polaris-family.css for explicitly scoped shared neutral roles, plus locker.css or locker.tokens.json for Locker. Capability display swatches preserve Key’s mappings; use upstream accessible UI roles for controls. Namespace Locker roles; do not overwrite Key or service tokens. Include an accessible name for standalone marks; avoid repeating it when adjacent text already names the brand. Review actual target UI for focus, contrast and reduced motion.

## Rebuild
Python 3 with cairosvg, pillow, fonttools, reportlab, svglib and pypdf. Run python source/build.py from the extracted kit directory. Fonts, the original Key PDF and all guide generators are bundled; all output paths are derived from the script location. Artwork geometry, export dimensions and document copy live in that script. The repository brand package has not been modified by this delivery.

## Licensing and provenance
Rubik is redistributed under the included SIL Open Font License. Brand artwork is supplied for the Polaris project; no trademark registration or third-party clearance claim is made. The original October Key guide is preserved as the basis. Its cover, visual identity, services and examples remain; the new Locker section governs public-facing application of that system. Concept source: user-selected A2 coral Bookends; final production drawing normalized to an explicit 128-unit artboard.

## Colour
Dark accent #ff7869. Light accent #c44438 (a contrast-adjusted companion to the exploratory coral). All mark artwork is flat. Transparent SVG/PDF are RGB source artwork; printers should proof conversions against their output profile.
''')
# Standalone badge pack contains artwork, usage and catalogue.
with zipfile.ZipFile(OUT/'Polaris-Locker-Badges-v1.zip','w',zipfile.ZIP_DEFLATED) as bz:
 for bp in (ROOT/'badges').rglob('*'):
  if bp.is_file():bz.write(bp,Path('Polaris-Locker-Badges')/bp.relative_to(ROOT/'badges'))
 bz.write(OUT/'Polaris-Locker-Badge-Catalogue-v1.pdf','Polaris-Locker-Badges/Polaris-Locker-Badge-Catalogue-v1.pdf')
(ROOT/'tokens/contrast-report.json').write_text(json.dumps([{'pair':n,'foreground':a,'background':b,'ratio':round(contrast(a,b),3)} for n,a,b in contrastrows],indent=2))
files=[p for p in ROOT.rglob('*') if p.is_file() and p.name!='manifest.json'];manifest={'version':'1.3.0','files':[{'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(files)]};(ROOT/'manifest.json').write_text(json.dumps(manifest,indent=2))
with zipfile.ZipFile(OUT/'Polaris-Locker-Launch-Kit-v1.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in ROOT.rglob('*'):
  if p.is_file():z.write(p,p.relative_to(OUT))
print(json.dumps({'files':len(files)+1,'pages':[len(PdfReader(OUT/f).pages) for f in ['Polaris-Locker-Brand-Guide-v1.pdf','Polaris-Key-Brand-Guide-Locker-Addendum-v1.pdf','Polaris-Key-Brand-Guide-with-Locker-v1.pdf']],'zip_bytes':(OUT/'Polaris-Locker-Launch-Kit-v1.zip').stat().st_size}))
