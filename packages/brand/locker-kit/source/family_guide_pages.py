# Final two pages in Locker's guide: a shared, explicit family specification.
G.page('19 / Shared foundations','Two identities. One design language.','Locker carries the public experience. Key retains the platform brand and its full identity guide.')
for x,key in [(44,'key'),(470,'locker')]:
 b=BRANDS[key]
 G.c.setFillColor(HexColor('#0d111b'));G.c.roundRect(x,347,386,95,10,fill=1,stroke=0)
 G.text(x+18,414,b['name'],22,600,b['darkAccent'])
 G.text(x+18,389,b['role'],12,400)
 G.text(x+18,369,b['mark'],11,400,MUTED)
rows=[
 ('Type','Rubik 400 body / 500 controls / 600 headings; regular badge prefixes.'),
 ('Grounds','Page #060912 / #F6F8FF; raised #0D111B / #FFFFFF.'),
 ('Text','Body #DBE4FF / #262D40; muted #B5BED3 / #48536B.'),
 ('Controls','Boundary #61697B / #7E8699; 44px primary targets and visible focus.'),
 ('Mark language','Stationary four-point star; flat colour; open gaps; approved paths.'),
 ('Spacing','One-quarter glyph-height clearance; preserve complete badge canvases.'),
 ('Voice and motion','Clear actions and recovery; stable star; honest progress; reduced motion.')
]
for j,(label,detail) in enumerate(rows):
 y=316-j*31
 G.text(44,y,label,12,500,CORAL);G.text(188,y,detail,11,400)
 G.c.setStrokeColor(HexColor('#303846'));G.c.line(44,y-11,856,y-11)
G.para(44,76,'Keep each approved silhouette and optical cut. This is a shared visual language, not one interchangeable logo. Both guides and token exports use source/family_system.py.',780,11)
G.end()

G.page('20 / Capability continuity','The same service means the same colour.','A coral Locker shell can carry a service accent. Preserve the capability system documented by Key.')
G.text(44,435,'CAPABILITY',10,500,MUTED);G.text(350,435,'DISPLAY ACCENT',10,500,MUTED);G.text(605,435,'KEY IDENTITY FAMILY',10,500,MUTED)
for j,(name,co,family) in enumerate(CAPABILITIES):
 y=404-j*31
 G.text(44,y,name,14,500)
 G.c.setFillColor(HexColor(co));G.c.roundRect(350,y-3,22,17,3,fill=1,stroke=0)
 G.text(385,y,co.upper(),12,400);G.text(605,y,family,12,400)
 G.c.setStrokeColor(HexColor('#303846'));G.c.line(44,y-10,856,y-10)
G.para(44,101,'Use one capability accent per story. These bright swatches are display references; inherit upstream fg / solid / on / subtle roles for actual UI. Coral names Locker, violet names Key, and gold retains signature meaning.',780,11)
G.para(44,51,'Public names and attribution remain Polaris Locker. Technical identifiers and host-owned brands remain accurate.',780,10)
G.end()
