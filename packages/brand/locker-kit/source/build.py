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
parent_source=ROOT/'source/Polaris-Key-Brand-Guide-Edition04.pdf'
if not parent_source.exists():shutil.copy('locker-work/reference/Polaris Key - Brand Guide.pdf',parent_source)
fontsrc=ROOT/'fonts/Rubik-Variable.ttf'
if not fontsrc.exists():shutil.copy('Rubik.ttf',fontsrc);shutil.copy('Rubik-OFL.txt',ROOT/'fonts/OFL.txt')
fonts={}
for w in [400,500,600]:
 p=ROOT/f'fonts/Rubik-{w}.ttf'; f=instantiateVariableFont(TTFont(fontsrc),{'wght':w},inplace=False);f.save(p);fonts[w]=f;pdfmetrics.registerFont(RLFont('R'+str(w),str(p)))
DARK='#060912';LIGHT='#f6f8ff';CORAL='#ff7869';DEEP='#c44438';BODY='#dbe4ff';MUTED='#b5bed3'
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
for phrase,slug in [('Available on','available-on'),('Open in','open-in')]:
 for theme in ['dark','light','white']:
  ink,st,txt=themes[theme]
  for style in ['transparent','sticker','outline']:
   bg=None if style=='transparent' else (LIGHT if theme=='light' else DARK)
   body=''
   if bg:body=f'<rect x="1" y="1" width="318" height="102" rx="18" fill="{bg}" stroke="{txt if style=="outline" else bg}" stroke-width="2"/>'
   body+='<g transform="translate(16,20) scale(.5)">'+glyph(ink,st)+'</g>'
   body+=textpath(phrase,96,42,14,txt,400)[0]+textpath('Polaris Locker',96,72,24,txt,500)[0]
   s=svg(body,320,104);save_svg(f'badges/locker-{slug}-{theme}-{style}.svg',s,pngsizes=[320,640,1280],pdf=True)
# Social templates, ready to publish; no invented product or availability claims.
for name,w,h in [('social-square',1080,1080),('social-landscape',1200,630),('social-portrait',1080,1350)]:
 body=f'<g transform="translate(72,64) scale(1.8)">{glyph()}</g>'
 body+=textpath('Polaris Locker',72,h*.58,72,BODY,600)[0]+textpath('Your collection. Your next discovery.',72,h*.58+68,30,MUTED,400)[0]
 body+=textpath('Library / Discover / Account',72,h-64,20,CORAL,400)[0]
 s=svg(body,w,h,DARK);save_svg(f'social/{name}.svg',s,pngsizes=[w])
# Tokens use deeper coral for light foreground, preserving selected bright coral on dark.
tokens={'version':'1.0.0','brand':'Polaris Locker','concept':'A2 compact bookends','dark':{'accent':CORAL,'onAccent':DARK,'page':DARK,'surface':'#0d111b','text':BODY,'muted':MUTED},'light':{'accent':DEEP,'onAccent':'#ffffff','page':LIGHT,'surface':'#ffffff','text':'#262d40','muted':'#48536b'},'font':{'family':'Rubik','body':400,'control':500,'heading':600},'clearSpace':'one quarter of visible glyph height','opticalCut':{'micro':'16-23 CSS px','master':'24 CSS px and above'}}
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
  c=self.c;self.i+=1;c.setFillColor(HexColor(DARK));c.rect(0,0,W,H,fill=1,stroke=0);self.text(44,600,'Polaris Locker',15,500);self.text(600,600,kicker.upper(),10,400,MUTED);c.setStrokeColor(HexColor('#303846'));c.line(44,581,856,581);self.text(44,526,title,34,600)
  if lead:self.para(44,492,lead,760,14)
  self.text(44,27,'POLARIS LOCKER / V1.0 / 19 OCTOBER 2026',9,400,MUTED);self.text(814,27,f'{self.i:02}',10,400,MUTED)
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
G.page('Brand guide','A place for what you love.','The consumer-facing home for your library, discovery and account.');G.art(svg(glyph()),90,120,300);G.block(440,330,'Compact Bookends / A2','Two open bookends hold a fixed star. The silhouette suggests an L without closing around the collection. Coral gives Locker its own welcoming identity within the Polaris family.');G.text(440,175,'Identity system / Edition 01',16,500);G.end()
G.page('Contents','Start with the right reference.');G.bullets([('03-05 / Identity','Positioning, architecture and the approved master.'),('06-10 / Foundations','Optical sizing, clear space, lockups, colour and typography.'),('11-15 / Expression','Composition, consumer journeys, voice, motion and attribution.'),('16-18 / Delivery','Misuse, asset selection and governance.')]);G.end()
G.page('03 / Positioning','Your collection. Your next discovery.','Use this as an expressive line, not a promise of features that are not available.');G.bullets([('Purpose','Polaris Locker is the user-facing home for a person’s software collection, discovery and account within the Polaris Key ecosystem.'),('Personality','Welcoming, capable and clear. Let people recognize what they own and understand their next action.'),('Language','Use Polaris Locker on first mention; Locker in a clearly established context. Navigation labels are Library, Discover and Account. Avoid calling the consumer experience an admin console.')]);G.end()
G.page('04 / Architecture','One family. Distinct responsibilities.');G.bullets([('Polaris Key','Developer platform and infrastructure. Keep the violet Pinned K and the existing capability identities.'),('Polaris Key Delivery','Delivery family using Star Cut. Distribution and Update retain their existing relationships and colours.'),('Polaris Locker','Consumer experience using coral Compact Bookends. It is a subbrand, not a new service slug or a replacement for Commerce.'),('Customer products','Product artwork, names and actions lead inside the collection. Locker provides the surrounding navigation and account context.')]);G.end()
G.page('05 / Master','The star stays open.','The supplied vectors are the production interpretation of selected concept A2.');G.art(svg(glyph()),65,135,315);G.block(465,380,'Three independent shapes','A tall left bookend, a shorter rising right bookend and one four-point star. Preserve the asymmetry, softened corners and clear gaps.');G.block(465,230,'Always use the master','Use the supplied SVG, outlined lockup or exported PNG. Never trace the concept image, rebuild the star, or create a new shelf arrangement.');G.end()
G.page('06 / Optical sizing','Small is a separate drawing.','Choose the cut by displayed size, not by export resolution or device pixel ratio.');
for i,n in enumerate([16,24,32,48,96]):
 x=55+i*160;G.art(svg(glyph(cut='micro' if n<24 else 'master')),x,315,n);G.text(x,285,f'{n}px',13)
G.block(44,210,'16-23px / Micro','Use the dedicated micro source for browser favicons and editor integrations. Simplified corners and a wider star preserve the three-part reading.');G.block(470,210,'24px and above / Master','The master supports service-size, navigation and display use. All cuts are flat; Locker has no signing bit or gradient.');G.end()
G.page('07 / Clear space','Give the mark room.');G.art(svg(glyph()),65,190,300);G.block(465,400,'Minimum clearance','Reserve at least one quarter of the visible glyph height around standalone marks and lockups. Background containers can be closer only in the supplied app-icon and badge canvases.');G.block(465,245,'Minimum use','Standalone mark: 24 CSS px square; micro exception: 16px. Horizontal lockup: 180px wide. Compact: 120px wide. Stacked: 160px wide. For crowded navigation, choose the mark with an accessible label.');G.end()
G.page('08 / Lockups','One name. Flexible proportions.');
for name,y,w in [('horizontal',350,490),('compact',190,260),('stacked',65,220)]:G.art((ROOT/f'logos/svg/locker-{name}-dark.svg').read_text(),60,y,w);G.text(600,y+45,name.capitalize(),16,500)
G.end()
G.page('09 / Colour','Coral belongs to Locker.','Use bright coral on dark; use the deeper companion on light for useful contrast.');
for i,(name,a,b) in enumerate(contrastrows):
 y=421-i*56;G.c.setFillColor(HexColor(a));G.c.roundRect(44,y-10,54,32,5,fill=1,stroke=0);G.text(120,y,name,16,500);G.text(440,y,a.upper(),14);G.text(640,y,f'{contrast(a,b):.2f}:1',14)
G.para(44,102,'Ratios are computed from the flat sRGB pairs shown. Bright coral is not the light-theme body-text colour. Gold remains the Key signing indicator; coral is never a success, warning or payment state by itself.',780,13);G.end()
G.page('10 / Typography','Friendly, with a clear hierarchy.');G.text(44,415,'Your library',58,600);G.text(46,365,'Find something worth opening.',26,400,MUTED);G.bullets([('Rubik / 400, 500, 600','400 body and badge prefixes; 500 controls and wordmarks; 600 headings. Avoid universal boldness.'),('Product rhythm','Body 16-18px, labels 14-16px, section titles 24-32px. Let long names wrap. Use at least 1.5 line height for reading copy.'),('Technical details','Use the parent system’s JetBrains Mono for diagnostic details only. The pack includes Rubik and its OFL notice; outlined logos need no installed font.')],y=290);G.end()
G.page('11 / Composition','Let the products lead.');G.bullets([('Page structure','Use the shared dark and light grounds. Keep coral for identity, selected navigation, focus and a restrained primary action.'),('Collection cards','Prioritize real product artwork and title, then access and a useful action. Device capacity and license detail support the decision.'),('Layout','Use a 4px spacing base, 24px section gutters and generous vertical spacing. On phones use one product column and keep the primary action reachable.'),('Imagery','Use authentic product art. When absent, use a solid-colour placeholder and initials. Do not invent product artwork or claim a product is available.')]);G.end()
G.page('12 / Journeys','Library, discovery, account.');G.bullets([('Library','Separate owned, downloadable, installed and unavailable states in text. Use Download or Open only when that action exists.'),('Discover','Use an editorial introduction and real product art. Distinguish owned, available and purchasable. Price and availability must reflect product data.'),('Account','Keep identity, recovery and device management calm. Explain consequences before removing access or signing out.'),('Host-owned experiences','On a developer’s own sign-in or product surface, the host identity still leads. Locker must not replace required Polaris Key attribution.')]);G.end()
G.page('13 / Voice','Make the next step obvious.');G.bullets([('Empty library','“Your library starts here.” Follow with the actual available action; avoid implying a store exists before it ships.'),('Offline','“You’re offline. Try again when you’re connected.” Preserve any usable local state; do not promise offline downloads or sign-in.'),('Recovery','“We couldn’t start this download. Try again.” Add a specific recovery step when known.'),('Action language','Prefer Open, Download, View details and Manage devices. Describe the user-visible outcome, not the internal service or transaction.')]);G.end()
G.page('14 / Motion','Hold the star still.');G.bullets([('Identity','Keep the star stationary. A one-time subtle reveal of the bookends can introduce the brand; avoid spinning, bouncing or perpetual logo animation.'),('Product','Use the parent motion system. Feedback follows the actual action and transfer state. Never imply measured download speed through staged progress.'),('Reduced motion','Remove spatial movement and decorative loops. Maintain focus and scroll position; communicate changes with text and state.'),('Interaction','Aim for 44px primary touch targets, visible keyboard focus and non-colour state cues. Check zoom, narrow screens and long translated strings.')]);G.end()
G.page('15 / Attribution','Keep the relationship readable.');G.art((ROOT/'badges/locker-available-on-dark-sticker.svg').read_text(),44,290,380);G.art((ROOT/'badges/locker-open-in-light-sticker.svg').read_text(),465,290,380);G.block(44,230,'Locker badges','Available on / Open in Polaris Locker. Supplied canvas: 320 x 104. Keep all vertical padding; the prefix stays Rubik 400. Use only where the destination or availability is real.');G.block(465,230,'Parent endorsement','Use the existing approved Powered by Polaris Key assets for infrastructure attribution. Locker badges do not replace them. Parent marks stay violet and retain their original geometry.');G.end()
G.page('16 / Misuse','Protect the open silhouette.');G.bullets([('Do not reshape','Never stretch, rotate, crop, mirror, close the gap, remove the star or make the bookends symmetrical.'),('Do not decorate','No bevel, texture, outline treatment, shadow or gradient on the mark. Do not add gold, a lock, keyhole or signing bit.'),('Do not recolour arbitrarily','Use supplied theme variants. Mono means one ink across all three shapes. Keep coral distinct from the parent’s service palette.'),('Do not overclaim','Artwork does not certify security, ownership, availability or performance. Product and trust states require their own labels and evidence.')]);G.end()
G.page('17 / Asset selection','Pick the file that fits.');G.bullets([('logos / SVG, PNG, PDF','Transparent marks and three outlined lockups in dark, light, white, black and coral. SVG is preferred for interfaces; PDF for vector placement in print.'),('icons + web','Square icon canvases, ICO, ICNS, dedicated micro favicon, touch icon and a sample web manifest. The maskable export has extra safe area.'),('badges + social','Transparent, sticker and outline badges; square, landscape and portrait campaign canvases. Confirm destination and copy before publishing.'),('tokens + source','CSS and JSON colour roles; Rubik fonts and OFL notice; reproducible Python generator. Platform-specific submission requirements remain the responsibility of each release.')]);G.end()
G.page('18 / Governance','A reviewed identity, ready to adopt.');G.bullets([('Source of truth','This pack is Locker v1, based on the user-selected A2 concept and the Polaris Key guide dated 8 October 2026. It does not claim to modify the platform repository.'),('Adoption','Add the reviewed master and scoped Locker tokens to packages/brand and docs/design/BRAND.md. Keep existing Key and Delivery identifiers and services unchanged.'),('Release checks','Inspect both themes and mono at 16, 24, 32, 48 and 96px. Verify labels, contrast, focus, actual assets and product states in the target renderer.'),('Versioning','Regenerate from source; record any geometry or token change as a new version. Keep the manifest and hashes with distributed exports.')]);G.end();G.save()
# Companion addendum: append-only amendment to edition 04.
A=Guide(OUT/'Polaris-Key-Brand-Guide-Locker-Addendum-v1.pdf','Polaris Key - Locker Addendum v1')
A.page('Addendum / Edition 04','Introducing Polaris Locker.','An addition to the Polaris Key Brand Guide, 8 October 2026.');A.art(svg(glyph()),60,150,280);A.block(420,370,'Consumer subbrand','Polaris Locker names the library, discovery and account experience. Its approved identity is A2 Compact Bookends in coral.');A.block(420,235,'Scope','This addendum extends the visual system. It does not rename services, change contracts or replace Pinned K and Star Cut.');A.end()
A.page('A02 / Amend pages 07-08','Add a consumer identity.');A.bullets([('Architecture','Add Polaris Locker / Compact Bookends alongside the existing platform and Delivery identities. Describe it as the consumer-facing product experience, not a backend capability.'),('Co-branding','Locker owns its app shell and consumer navigation. The customer’s product artwork leads within library cards and product details.'),('Attribution','Retain the approved Powered by Polaris Key badges for the infrastructure relationship. Available on / Open in Polaris Locker identify a consumer destination only.')]);A.end()
A.page('A03 / Amend pages 09-10','Add coral. Keep existing roles.');A.bullets([('Locker dark','Accent #ff7869; on-accent #060912. Page #060912; surface #0d111b. White star on dark artwork.'),('Locker light','Accent #c44438; on-accent #ffffff. Page #f6f8ff; surface #ffffff. Deep coral star and bookends on light artwork.'),('Unchanged parent rules','Key stays violet; Delivery stays Star Cut. Service colours and gold signing semantics are unchanged. Coral does not replace Distribution green or Update orange.'),('Typography','Inherit Rubik 400/500/600 and the existing technical counterpoint. Locker wordmarks are supplied as outlines; badge prefixes remain regular weight.')]);A.end()
A.page('A04 / Amend pages 24, 30-32','Name the consumer experience.');A.bullets([('Customer portal','Apply Locker branding to Library, Discover and Account shell surfaces. Retain edition 04’s artwork-led layout and visible useful actions.'),('Account and recovery','Use quieter coral emphasis, shared neutral surfaces and explicit action consequences. Preserve product and provider identity where it is required.'),('Host-owned kits','Do not automatically replace developer product branding or Polaris Key attribution with Locker. Keep supported host customization.'),('Responsive systems','Use the 16px micro drawing below 24px; master at 24px+. Retain keyboard, controller, zoom, narrow-screen and reduced-motion behaviour.')]);A.end()
A.page('A05 / Artwork rules','Use the supplied Bookends master.');A.art(svg(glyph()),60,185,290);A.block(440,395,'Geometry','Three separate shapes; asymmetric bookends; one stationary four-point star. Clear space is one quarter of visible glyph height.');A.block(440,245,'Delivery','Use the outlined lockups, light/dark variants and dedicated micro cut. Mono is one ink. No gradients, signing bit, service recolouring or replacement of the parent master.');A.end()
A.page('A06 / Amend pages 27, 35','Adopt deliberately.');A.bullets([('Approved design decision','A2 Compact Bookends and coral selected in this conversation on 19 October 2026. This addendum supplies production artwork and usage rules.'),('Repository integration','Integrate reviewed assets and scoped Locker tokens into the canonical brand package. This deliverable does not claim that repository adoption has occurred.'),('Verification','Review actual target applications and native integrations. The pack includes raster size specimens and computed colour-pair ratios; these do not certify a complete application.'),('Edition handling','Keep edition 04 intact and append these six pages. The combined reference copy includes the unchanged original guide followed by this addendum.')]);A.end();A.save()
writer=PdfWriter();writer.append(parent_source);writer.append(OUT/'Polaris-Key-Brand-Guide-Locker-Addendum-v1.pdf');writer.write(OUT/'Polaris-Key-Brand-Guide-with-Locker-v1.pdf')
for f in ['Polaris-Locker-Brand-Guide-v1.pdf','Polaris-Key-Brand-Guide-Locker-Addendum-v1.pdf','Polaris-Key-Brand-Guide-with-Locker-v1.pdf']:shutil.copy(OUT/f,ROOT/'docs'/f)
# QA contact sheet uses actual raster exports at native and 4x nearest-neighbour scale.
qa=Image.new('RGB',(1120,720),DARK);draw=ImageDraw.Draw(qa);pf=ImageFont.truetype(str(ROOT/'fonts/Rubik-400.ttf'),18)
for row,(theme,bg) in enumerate([('dark',DARK),('light',LIGHT),('white',DARK),('black',LIGHT)]):
 y=row*180;draw.rectangle((0,y,1120,y+180),fill=bg);fg='white' if bg==DARK else 'black';draw.text((15,y+12),theme,fill=fg,font=pf)
 for col,n in enumerate([16,24,32,48,96]):
  im=Image.open(ROOT/f'logos/png/locker-mark-{theme}-{n}.png');x=140+col*190;qa.paste(im,(x,y+28),im);draw.text((x,y+140),str(n)+'px',fill=fg,font=pf)
qa.save(ROOT/'previews/size-theme-check.png')
# A large cover preview.
preview=svg('<g transform="translate(90,110) scale(2.8)">'+glyph()+'</g>'+textpath('Polaris Locker',500,300,60,BODY,600)[0]+textpath('Compact Bookends / Coral / v1.0',500,355,24,MUTED,400)[0],1200,630,DARK);png(preview,ROOT/'previews/identity.png',1200)
(ROOT/'web/README.md').write_text('Use favicon.svg with rel="icon" type="image/svg+xml"; favicon.ico as fallback; apple-touch-icon.png for touch devices. Link site.webmanifest after setting the final start_url, scope and deployment paths. Serve assets with correct MIME types. maskable-512.png has additional safe area.\n')
(ROOT/'README.md').write_text('''# Polaris Locker / Launch Kit v1.0

Approved direction: A2 Compact Bookends in coral. Date: 19 October 2026.

Start with docs/Polaris-Locker-Brand-Guide-v1.pdf. The Key addendum is also provided separately and appended to an unchanged copy of the 35-page October guide.

## Use
- Use logos/svg for sharp interfaces and logos/pdf for vector placement.
- Names dark/light identify intended background. White/black/coral are one-ink variants.
- Use the micro source below 24 CSS px. All 16px and 20px mark exports use it.
- Lockups are outlined Rubik: no font dependency. PNGs are transparent unless explicitly app/social/sticker assets.
- Square app icons intentionally have no baked-in platform corner mask. Apply platform masks at integration time.
- The ICO contains an explicit micro 16px layer. ICNS and web assets are included.
- badges retain generous vertical padding and regular-weight prefixes. Never crop their canvas.
- “Available on” needs real availability; “Open in” needs a real destination.
- Existing approved Powered by Polaris Key assets remain the infrastructure attribution. This pack does not redraw the Pinned K.

## Implementation
Import tokens/locker.css or locker.tokens.json. Namespace Locker roles; do not overwrite Key or service tokens. Include an accessible name for standalone marks; avoid repeating it when adjacent text already names the brand. Review actual target UI for focus, contrast and reduced motion.

## Rebuild
Python 3 with cairosvg, pillow, fonttools, reportlab, svglib and pypdf. Run python source/build.py from the extracted kit directory. Fonts and the October parent guide are bundled; all output paths are derived from the script location. Artwork geometry, export dimensions and document copy live in that script. The repository brand package has not been modified by this delivery.

## Licensing and provenance
Rubik is redistributed under the included SIL Open Font License. Brand artwork is supplied for the Polaris project; no trademark registration or third-party clearance claim is made. The original October guide remains unchanged in the combined reference. Concept source: user-selected A2 coral Bookends; final production drawing normalized to an explicit 128-unit artboard.

## Colour
Dark accent #ff7869. Light accent #c44438 (a contrast-adjusted companion to the exploratory coral). All mark artwork is flat. Transparent SVG/PDF are RGB source artwork; printers should proof conversions against their output profile.
''')
(ROOT/'tokens/contrast-report.json').write_text(json.dumps([{'pair':n,'foreground':a,'background':b,'ratio':round(contrast(a,b),3)} for n,a,b in contrastrows],indent=2))
files=[p for p in ROOT.rglob('*') if p.is_file() and p.name!='manifest.json'];manifest={'version':'1.0.0','files':[{'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(files)]};(ROOT/'manifest.json').write_text(json.dumps(manifest,indent=2))
with zipfile.ZipFile(OUT/'Polaris-Locker-Launch-Kit-v1.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in ROOT.rglob('*'):
  if p.is_file():z.write(p,p.relative_to(OUT))
print(json.dumps({'files':len(files)+1,'pages':[len(PdfReader(OUT/f).pages) for f in ['Polaris-Locker-Brand-Guide-v1.pdf','Polaris-Key-Brand-Guide-Locker-Addendum-v1.pdf','Polaris-Key-Brand-Guide-with-Locker-v1.pdf']],'zip_bytes':(OUT/'Polaris-Locker-Launch-Kit-v1.zip').stat().st_size}))
