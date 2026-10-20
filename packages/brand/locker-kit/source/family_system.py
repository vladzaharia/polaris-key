"""Shared reference for the Key platform and Locker public brand.

Brand geometry is intentionally separate. This specification extends Edition 04;
it does not replace the upstream Key artwork or runtime token generator.
"""
REVISION = '1.3.0'
FAMILY_DARK = {'page':'#060912','surface':'#0d111b','text':'#dbe4ff','muted':'#b5bed3','controlBoundary':'#61697b'}
FAMILY_LIGHT = {'page':'#f6f8ff','surface':'#ffffff','text':'#262d40','muted':'#48536b','controlBoundary':'#7e8699'}
FAMILY_FONTS = {'family':'Rubik','technical':'JetBrains Mono','body':400,'control':500,'heading':600,'badgePrefix':400}
BRANDS = {
 'key':{'name':'Polaris Key','role':'Underlying platform','mark':'Pinned K; Star Cut for Delivery','darkAccent':'#9a5cff','lightAccent':'#7a2fff'},
 'locker':{'name':'Polaris Locker','role':'All public-facing Polaris surfaces','mark':'A2 Compact Bookends','darkAccent':'#ff7869','lightAccent':'#c44438'}
}
CAPABILITIES = [
 ('License','#c6e940','Pinned K'),('Config','#fac700','Pinned K'),
 ('Release','#00dbfd','Pinned K'),('Distribution','#39d075','Star Cut'),
 ('Update','#fe8001','Star Cut'),('Identity','#d77df2','Pinned K'),
 ('Cloud Sync','#14f8e1','Pinned K'),('Commerce','#39d075','Star Cut'),
 ('Content Packs','#fe8001','Star Cut')
]
FAMILY = {
 'version':REVISION,
 'authority':'Key Edition 04 foundations; selected Locker A2; 19 October public-brand decision',
 'brands':BRANDS,'dark':FAMILY_DARK,'light':FAMILY_LIGHT,'font':FAMILY_FONTS,
 'geometry':{'star':'Stationary four-point motif; use each approved drawing, not a swapped or redrawn star','clearSpace':'At least one quarter of visible glyph height','minimumMarkCssPx':24,'microExceptionCssPx':16,'smallMark':'Flat colour, no gradient; white star on dark; single ink in mono'},
 'opticalCuts':{'key':{'micro':'16-23 CSS px','service':'24-32 CSS px','display':'Above 32 CSS px; signing bit only at 48px and above'},'locker':{'micro':'16-23 CSS px','master':'24 CSS px and above'}},
 'interaction':{'primaryTargetCssPx':44,'readingLineHeight':[1.6,1.75],'stateCues':'Text or shape as well as colour','focus':'Visible focus on every actual background'},
 'motion':{'pressMs':80,'navigationMs':[200,260],'entranceMs':[320,480],'reducedMotion':'Remove spatial movement and decorative loops','authority':'Reference ranges from Key Edition 04; canonical runtime motion system governs implementation'},
 'capabilities':[{'name':n,'displayAccent':c,'keyFamily':f} for n,c,f in CAPABILITIES],
 'colourScope':'Coral identifies Locker; violet identifies Key. Keep capability accents unchanged in either context. Bright capability swatches are display references, not universal text or control colours.',
 'badge':{'publicBrand':'Polaris Locker','prefixWeight':400,'lockerCanvas':[320,104],'lockerMinimumWidthCssPx':320,'padding':'Preserve the complete supplied canvas and vertical space. Approved Key badge canvases retain their own proportions.'},
 'reserved':{'signatureDark':'#ffc24d','signatureLight':'#d07a00','signatureRule':'Gold is signature meaning, not premium or warning. No signing bit on Locker or badges.','parentBlue':'#3b82ff','excludedKeyIndigo':'#5b7cfa'}
}

def write_family_files(root):
 import json
 (root/'tokens/polaris-family.tokens.json').write_text(json.dumps(FAMILY,indent=2))
 css=['/* Shared neutral foundations; explicitly opt in with data-polaris-brand. */', '[data-polaris-brand] {']
 for k,v in FAMILY_DARK.items():css.append(f'  --polaris-{k}: {v};')
 css.extend(['  --polaris-font: Rubik, system-ui, sans-serif;','  --polaris-body-weight: 400;','  --polaris-control-weight: 500;','  --polaris-heading-weight: 600;','  --polaris-prefix-weight: 400;','  --polaris-reading-line-height: 1.6;','  --polaris-primary-target: 44px;','}', '[data-theme="light"][data-polaris-brand], [data-theme="light"] [data-polaris-brand] {'])
 for k,v in FAMILY_LIGHT.items():css.append(f'  --polaris-{k}: {v};')
 css.append('}')
 for key,b in BRANDS.items():
  css.extend([f'[data-polaris-brand="{key}"] {{ --polaris-brand-accent: {b["darkAccent"]}; }}',f'[data-theme="light"][data-polaris-brand="{key}"], [data-theme="light"] [data-polaris-brand="{key}"] {{ --polaris-brand-accent: {b["lightAccent"]}; }}'])
 (root/'tokens/polaris-family.css').write_text('\n'.join(css)+'\n')
 (root/'docs/brand-alignment.md').write_text('''# Polaris family / alignment specification 1.3

Polaris Locker is the public-facing identity. Polaris Key remains the underlying platform and a complete brand in its own guide. Key's Edition 04 is preserved, with a focused Locker section after the service pages.

| Foundation | Shared rule |
| --- | --- |
| Type | Rubik 400 body and badge prefixes; 500 controls; 600 headings. JetBrains Mono for technical content. Use supplied outlined wordmarks. |
| Grounds | Dark #060912, light #f6f8ff; raised #0d111b / #ffffff. |
| Text | Body #dbe4ff / #262d40; muted #b5bed3 / #48536b. |
| Controls | Boundary #61697b / #7e8699; aim for 44px primary targets, visible focus and non-colour state cues. |
| Motif | Stationary four-point star, flat colour, open negative space. Preserve each brand's approved geometry. |
| Spacing | At least one quarter of visible glyph height around standalone artwork. Preserve each supplied badge canvas. |
| Small marks | 24px minimum with a dedicated 16px exception. Select optical cuts by displayed CSS size. |
| Voice | Capable, considerate and precise. State the action, real product state and recovery. |
| Motion | Keep the star and focused controls stable; show actual progress; remove spatial movement for reduced motion. |

## What stays distinctive

Key: violet #9a5cff on dark / #7a2fff on light; Pinned K and Star Cut. Locker: coral #ff7869 on dark / #c44438 on light; A2 Compact Bookends. Their logo and optical-cut drawings remain separate. Do not fuse marks, swap stars or recolour one brand into the other.

## Services inside Locker

Use Locker for the public shell and attribution. Keep existing capability names, service symbols and accent mappings. A License panel may retain its lime accent under a coral Locker header. Select one capability accent per story; do not turn every service coral. Public top-level identity never switches to Key simply because the surface is technical. Key can be named accurately in an explanation of the underlying platform.

Use bright service colours as display references only; retain upstream fg / solid / on / subtle roles and test actual pairings. Gold communicates signature meaning, not payment, premium or warning. Parent blue remains reserved for the Polaris/Suite identity.

## Badges

All public action badges name Polaris Locker. Prefixes use Rubik 400. Keep the complete 320 x 104 canvas at 320 CSS px wide or larger; high-resolution PNGs do not change displayed minimums. Transparent, sticker and outline styles share identical geometry. Key's approved historical badge canvases remain platform-brand references and keep their own dimensions. Labels identify real supported actions; artwork does not implement a purchase or login flow.

## Sources and scope

Both guides and tokens read source/family_system.py. Tokens are reference exports for integration; the existing upstream Key generator remains authoritative for Key paths and runtime service roles. No live deployment, code identifier or API contract is changed by this asset update. JetBrains Mono is specified but not redistributed in this kit; Rubik and its OFL notice are included.
''')
