# Full badge index and a five-page visual catalogue.
uses={
'powered-by':'Attribute an actual Polaris-backed integration.',
'available-on':'Point to a real listing or availability destination.',
'available-in':'Show content included in a Locker collection or destination.',
'open-in':'Open an existing item in Locker.',
'get-it-on':'Link to a real acquisition or listing destination.',
'download-from':'Start or locate a supported download.',
'install-with':'Use only for an actual supported installation flow.',
'play-on':'Link to a playable game or supported launch destination.',
'purchase-with':'Enter a supported purchase flow; do not imply unsupported payment processing.',
'buy-on':'Link to a purchasable listing.',
'login-with':'Enter an actual Locker authentication flow.',
'sign-in-with':'Alternative wording for the same authentication action.',
'connect-with':'Connect an account or supported integration.',
'manage-with':'Open a supported account or product-management workflow.',
'sync-with':'Identify an actual supported synchronization flow.',
'update-with':'Identify an actual supported update flow.'}
C=Guide(OUT/'Polaris-Locker-Badge-Catalogue-v1.pdf','Polaris Locker / Badge catalogue / Revision 1.3')
C.footer='POLARIS LOCKER / BADGE CATALOGUE / REV 1.3 / 19 OCTOBER 2026'
for batch in range(4):
 C.page('Badges / '+str(batch+1),'Choose the action.','The same roomy canvas, regular-weight prefix and coral Bookends across all 16 labels.')
 for j,(phrase,slug) in enumerate(BADGES[batch*4:batch*4+4]):
  y=370-j*98
  C.art((ROOT/f'badges/locker-{slug}-dark-outline.svg').read_text(),44,y,256)
  C.art((ROOT/f'badges/locker-{slug}-light-sticker.svg').read_text(),330,y,256)
  C.text(620,y+55,phrase,16,500,CORAL);C.para(620,y+31,uses[slug],232,11)
 C.end()
C.page('Styles and delivery','Pick the ground. Keep the padding.','All 16 labels have nine SVG variants, matching vector PDFs, and 1x / 2x / 4x PNG exports.')
for row,theme in enumerate(['dark','light','white']):
 for col,style in enumerate(['transparent','sticker','outline']):
  x=44+col*277;y=324-row*113
  # Preview light artwork on a light field; exported transparent artwork has no background.
  bg=LIGHT if theme=='light' else DARK
  C.c.setFillColor(HexColor(bg));C.c.roundRect(x-5,y-4,266,92,8,fill=1,stroke=0)
  C.art((ROOT/f'badges/locker-powered-by-{theme}-{style}.svg').read_text(),x,y,256)
  C.text(x,y+94,theme.capitalize()+' / '+style,11,400,MUTED)
C.para(44,61,'Canvas / minimum display: 320 x 104. SVG / PDF are vectors. PNG widths: 320, 640 and 1280. Do not crop padding. Theme names describe the intended ground; white is single-ink artwork.',780,10)
C.end();C.save()
index={'revision':'1.3.0','brand':'Polaris Locker','canvas':[320,104],'minimumDisplayWidthCssPx':320,'familyRevision':REVISION,'prefixWeight':400,'wordmarkWeight':500,'pngWidths':[320,640,1280],'themes':['dark','light','white'],'styles':['transparent','sticker','outline'],'labels':[{'label':phrase,'slug':slug,'use':uses[slug],'filePattern':f'locker-{slug}-{{theme}}-{{style}}.svg'} for phrase,slug in BADGES]}
(ROOT/'badges/index.json').write_text(json.dumps(index,indent=2))
(ROOT/'badges/README.md').write_text('''# Polaris Locker badges / revision 1.3

16 labels, each with dark, light and white mono variants in transparent, sticker and outline styles. Every combination includes an outlined SVG, vector PDF and PNGs at 320, 640 and 1280px wide. Master canvas and minimum displayed size: 320 x 104 CSS px. Keep all vertical padding. Prefixes use Rubik 400; the brand name uses 500. This follows the shared Polaris typography and spacing principles. Preserve approved Key badge proportions in platform references; public badges use Locker.

Use the exact label matching the real action. A Play on badge needs a playable destination; Purchase with requires a real purchase flow and does not imply unsupported payment processing; Login with / Sign in with require an authentication integration. Other labels likewise need real destinations or capabilities.

“Login with” is included exactly as requested; “Sign in with” is an alternative. The artwork is a visual badge, not an implemented login or purchase control. Add the appropriate accessible link name and destination when integrating it.

Use the SVG for scalable interfaces, PNG for raster-only surfaces and PDF for vector placement. Light files are for light grounds; dark files are for dark grounds. White variants use one white ink. Transparent files contain no background; sticker and outline styles own their background.

The catalogue previews two combinations per label plus the complete nine-style matrix. index.json lists every label, intended use, format and file pattern. All brand text is outlined; font installation is unnecessary.
''')
