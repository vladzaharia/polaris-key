# Preserve the original Polaris Key guide and add a service-style Locker section.
from pypdf.annotations import Link
from pypdf.generic import Fit, NameObject, ArrayObject
PW,PH=594.95996,841.91998
source=PdfReader(ROOT/'source/reference/Polaris-Key-Brand-Guide-Edition04.pdf')
section=OUT/'Polaris-Key-Brand-Guide-Locker-Addendum-v1.pdf'
pc=canvas.Canvas(str(section),pagesize=(PW,PH))
pc.setTitle('Polaris Key / Polaris Locker brand section / revision 1.3')
pc.setAuthor('Polaris')
def pt(x,y,s,size=11,weight=400,col=BODY):
 pc.setFillColor(HexColor(col));pc.setFont('R'+str(weight),size);pc.drawString(x,y,s)
def pp(x,y,s,width=499,size=11):
 line=''
 for word in s.split():
  trial=(line+' '+word).strip()
  if pdfmetrics.stringWidth(trial,'R400',size)>width:pt(x,y,line,size);y-=size*1.5;line=word
  else:line=trial
 if line:pt(x,y,line,size)
 return y-size*1.7
def pb(x,y,title,body,width=235):pt(x,y,title,13,500,CORAL);return pp(x,y-23,body,width)
def pa(path,x,y,w):
 d=svg2rlg(str(ROOT/path));scale=w/d.width;d.scale(scale,scale);renderPDF.draw(d,pc,x,y)
def pg(n,label,title,lead):
 pc.setFillColor(HexColor(DARK));pc.rect(0,0,PW,PH,fill=1,stroke=0)
 pt(48,785,'Polaris Key',12,600,'#ffffff');pt(356,785,'Brand guide / October 2026',9)
 pc.setStrokeColor(HexColor('#3d4555'));pc.line(48,754,547,754)
 pt(48,728,label.upper(),8,500,CORAL);pt(48,681,title,34,600,'#ffffff');pp(48,647,lead,499,12)
 pc.line(48,40,547,40);pt(48,25,'POLARIS KEY / BRAND GUIDE',7,400,MUTED);pt(505,25,f'{n:02} / 38',8,400,MUTED)
pg(21,'PUBLIC IDENTITY / POLARIS LOCKER','Polaris Locker','One public identity, built on the Polaris Key platform.')
pa(Path('logos/svg/locker-horizontal-dark.svg'),48,490,430)
pb(48,448,'Polaris Key / Platform brand','Key retains its own brand, Pinned K, Star Cut, colours and service identities. This guide continues to document and celebrate that platform identity.')
pb(312,448,'Polaris Locker / Public identity','Locker uses coral A2 Compact Bookends on public-facing product surfaces: marketing, docs, console, sign-in, downloads, communications and integrations.')
pb(48,297,'How to apply this guide','Keep the original Key examples as references for the platform brand, capabilities and visual language. For public-facing deployment, apply Locker identity as described in this section.',499)
pb(48,172,'A focused distinction','This section governs public naming where earlier pages show Key-branded public examples. It does not remove the Key brand, rename technical interfaces or replace the guide’s service rules.',499)
pc.showPage()
pg(22,'POLARIS LOCKER / BRAND ESSENTIALS','Same family. Clear roles.','The abridged Locker specification; use the full Locker guide for detailed applications.')
pa(Path('logos/svg/locker-mark-dark-master.svg'),48,417,170)
pb(260,553,'Compact Bookends / A2','Two asymmetric bookends and one stationary four-point star. Preserve the three separate shapes, open gaps and original proportions.',287)
pb(260,445,'Small sizes and spacing','24px minimum; dedicated 16px exception. Locker master at 24px+; preserve Key’s optical cuts. Clear space: one quarter of visible glyph height.',287)
for x,co,lab in [(48,CORAL,'Dark / #FF7869'),(312,DEEP,'Light / #C44438')]:
 pc.setFillColor(HexColor(co));pc.roundRect(x,318,235,40,5,fill=1,stroke=0);pt(x,295,lab,12,500)
pp(48,262,'Shared: Rubik 400 / 500 / 600, grounds #060912 / #F6F8FF, flat artwork and a stationary four-point star motif. Use each brand’s approved drawing. Locker has no signing bit. Primary targets: 44px; prefixes: regular 400.',499,11)
pb(48,166,'Same capabilities. Shared foundations.','Locker’s coral shell retains Key’s service names, symbols and accent mappings. Body, muted text, raised surfaces and control boundaries share the Key palette. Follow Key’s motion and accessibility rules. See Locker pages 19-20 and tokens/polaris-family.tokens.json.',499)
pc.showPage()
pg(23,'POLARIS LOCKER / BADGES','Name the action.','A consistent badge family for attribution, availability, play, purchase and account actions.')
for path,x,y in [('available-in',48,481),('play-on',312,481),('purchase-with',48,361),('login-with',312,361)]:
 pa(Path(f'badges/locker-{path}-dark-outline.svg'),x,y,235)
pp(48,310,'Also included: Powered by, Available on, Open in, Get it on, Download from, Install with, Buy on, Sign in with, Connect with, Manage with, Sync with and Update with.',499,11)
pb(48,225,'One consistent construction','Keep the full 320 x 104 canvas at 320px wide or larger, with generous vertical padding and regular-weight prefixes. Dark, light and mono artwork is available in transparent, sticker and outline styles.')
pb(312,225,'Match the actual destination','Use Play on for playable content, Purchase with for a purchase flow and Login with for authentication. A badge should never imply an unsupported capability.')
pp(48,81,'The full badge catalogue and SVG / PNG / PDF exports are included in the launch kit. Public-facing Polaris badges use Locker; the Key identity remains documented in this guide.',499,9)
pc.showPage();pc.save()
# Insert after the existing nine capability pages. Preserve source page objects.
w=PdfWriter();w.clone_document_from_reader(source)
sec=PdfReader(section)
for j,p in enumerate(sec.pages):w.insert_page(p,index=20+j)
# Existing page links keep their destination page objects; rebuild only the contents page.
entries=[(3,'Strategy'),(4,'Identity'),(5,'Artwork / variants'),(6,'Artwork / optical sizing'),(7,'Architecture'),(8,'Co-branding'),(9,'Color'),(10,'Typography'),(11,'Composition'),(12,'Service identity / License'),(13,'Service identity / Config'),(14,'Service identity / Release'),(15,'Service identity / Distribution'),(16,'Service identity / Update'),(17,'Service identity / Identity'),(18,'Service identity / Cloud Sync'),(19,'Service identity / Commerce'),(20,'Service identity / Content Packs'),(21,'Polaris Locker / public identity'),(22,'Polaris Locker / brand essentials'),(23,'Polaris Locker / badges'),(24,'Motion'),(25,'Voice & campaigns'),(26,'Iconography & imagery'),(27,'Product expression'),(28,'Campaign applications'),(29,'Accessibility & delivery'),(30,'Research & governance'),(31,'Product expression / admin workspace'),(32,'Product expression / records and data'),(33,'Product expression / customer portal'),(34,'Product expression / identity and kits'),(35,'Product expression / responsive systems'),(36,'Product motion / interaction'),(37,'Product voice / useful copy'),(38,'Governance')]
for i,page in enumerate(w.pages):
 if 20<=i<=22:continue
 buffer=io.BytesIO();o=canvas.Canvas(buffer,pagesize=(PW,PH));o.setFillColor(HexColor(DARK));o.rect(504,20,47,16,fill=1,stroke=0);o.setFillColor(HexColor(MUTED));o.setFont('R400',7.5);o.drawRightString(547,25,f'{i+1:02} / 38')
 if i==1:
  # Replace the contents page, avoiding duplicate hidden table text.
  page[NameObject('/Contents')]=ArrayObject()
  o.setFillColor(HexColor(DARK));o.rect(0,0,PW,PH,fill=1,stroke=0)
  o.setFillColor(HexColor('#ffffff'));o.setFont('R600',12);o.drawString(48,785,'Polaris Key')
  o.setFillColor(HexColor(BODY));o.setFont('R400',9);o.drawRightString(547,785,'Brand guide / October 2026')
  o.setStrokeColor(HexColor('#3d4555'));o.line(48,754,547,754)
  o.setFillColor(HexColor('#9a5cff'));o.setFont('R500',8);o.drawString(48,730,'FIND YOUR REFERENCE')
  o.setFillColor(HexColor('#ffffff'));o.setFont('R600',32);o.drawString(48,689,'The identity system.')
  o.setFillColor(HexColor(BODY));o.setFont('R400',10);o.drawString(48,655,'Edition 04 + Locker section. Select a section to jump to its page.')
  o.setStrokeColor(HexColor('#3d4555'));o.line(48,40,547,40)
  o.setFillColor(HexColor(MUTED));o.setFont('R400',7.5);o.drawString(48,25,'POLARIS KEY / BRAND GUIDE');o.drawRightString(547,25,'02 / 38')
  for j,(num,title) in enumerate(entries):
   x=48 if j%2==0 else 310;y=620-(j//2)*28.7
   o.setFillColor(HexColor(CORAL if num in [21,22,23] else '#9a5cff'));o.setFont('R400',8.6);o.drawString(x,y,f'{num:02}');o.drawString(x+18,y,title)
   o.setStrokeColor(HexColor('#3d4555'));o.line(x,y-10,x+237,y-10)
  o.setFillColor(HexColor(BODY));o.setFont('R400',8.5);o.drawString(48,83,'Key identity and services are retained. The Locker section defines public-facing use.')
 o.save();page.merge_page(PdfReader(buffer).pages[0])
w.pages[1][NameObject('/Annots')]=ArrayObject()
for j,(num,title) in enumerate(entries):
 x=48 if j%2==0 else 310;y=620-(j//2)*28.7
 w.add_annotation(1,Link(rect=(x,y-10,x+237,y+11),target_page_index=num-1,fit=Fit.fit()))
parent=w.add_outline_item('Polaris Locker / public identity',20)
w.add_outline_item('Locker / brand essentials',21,parent=parent);w.add_outline_item('Locker / badges',22,parent=parent)
w.add_metadata({'/Title':'Polaris Key - Brand Guide with Polaris Locker','/Author':'Polaris','/Subject':'Original Edition 04 identity and service guide, with a focused Locker section. Revision 1.3, 19 October 2026.'})
w.write(OUT/'Polaris-Key-Brand-Guide-with-Locker-v1.pdf')
