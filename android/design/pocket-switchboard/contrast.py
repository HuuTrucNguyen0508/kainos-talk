# WCAG 2.x contrast, computed from the token values declared in index.html (not estimated).
import re, pathlib
html = (pathlib.Path(__file__).parent/'index.html').read_text()
def block(a,b):
    seg = html[html.index(a):html.index(b)]
    return dict(re.findall(r'--([a-z-]+):\s*(#[0-9a-fA-F]{6})', seg))
T = {'light': block('/* TOKENS-LIGHT */','/* TOKENS-DARK */'), 'dark': block('/* TOKENS-DARK */','/* TOKENS-END */')}
def lum(h):
    h=h.lstrip('#'); r,g,b=[int(h[i:i+2],16)/255 for i in (0,2,4)]
    f=lambda c: c/12.92 if c<=0.04045 else ((c+0.055)/1.055)**2.4
    return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)
def cr(a,b):
    la,lb=sorted((lum(a),lum(b)),reverse=True); return (la+0.05)/(lb+0.05)
pairs=[
 ('BODY  ink on surface (names, mail body, headings)','ink','surface',4.5),
 ('BODY  ink on raised (incoming bubble, mail slip)','ink','raised',4.5),
 ('BODY  ink on board (origin card title)','ink','board',4.5),
 ('BODY  on-out on out (sent bubble text and time)','on-out','out',4.5),
 ('SECOND soft on surface (previews, times, captions)','soft','surface',4.5),
 ('SECOND soft on raised (bubble time, photo label)','soft','raised',4.5),
 ('SECOND soft on board (socket labels, hints, origin text)','soft','board',4.5),
 ('ACCENT teal on surface (text buttons, active socket label)','teal','surface',4.5),
 ('ACCENT teal on raised (sender names, open icon)','teal','raised',4.5),
 ('ACCENT teal on board (avatar initials, Open in WhatsApp)','teal','board',4.5),
 ('ERROR alert on surface (Not sent text)','alert','surface',4.5),
 ('BADGE lamp-ink on lamp (unread count)','lamp-ink','lamp',4.5),
 ('BADGE soft on surface (muted hollow count)','soft','surface',4.5),
 ('BADGE on-line on wa (W jack/tile letter)','on-line','wa',4.5),
 ('BADGE on-line on dc (D jack/tile letter)','on-line','dc',4.5),
 ('BADGE on-line on pm (M jack/tile letter)','on-line','pm',4.5),
 ('CONTROL on-teal on teal (button label, send icon, app mark)','on-teal','teal',4.5),
 ('NONTEXT lamp-edge on surface (lamp bezel)','lamp-edge','surface',3),
 ('NONTEXT lamp-edge on board (lamp bezel on socket)','lamp-edge','board',3),
 ('NONTEXT outline on surface (muted lamp ring)','outline','surface',3),
 ('NONTEXT outline on board (reply field border)','outline','board',3),
 ('NONTEXT outline on raised (photo placeholder, slip cut)','outline','raised',3),
 ('NONTEXT alert on surface (failed bubble border)','alert','surface',3),
 ('NONTEXT teal on board (send button, big button)','teal','board',3),
 ('NONTEXT wa on surface / board','wa','surface',3),('NONTEXT wa on board','wa','board',3),
 ('NONTEXT dc on surface','dc','surface',3),('NONTEXT dc on board','dc','board',3),
 ('NONTEXT pm on surface','pm','surface',3),('NONTEXT pm on board','pm','board',3),
 ('NONTEXT ink on board (gesture bar, icons)','ink','board',3),
]
bad=0
for th,t in T.items():
    print('==',th)
    for name,a,b,need in pairs:
        r=cr(t[a],t[b]); ok=r>=need; bad+=not ok
        print(f"{'ok  ' if ok else 'FAIL'} {r:5.2f}:1 (min {need}) {name}: {t[a]} / {t[b]}")
print('failures:',bad)
