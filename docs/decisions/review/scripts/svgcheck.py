import re,sys,html
# per-class px per character (empirical for Plex Sans Condensed / JetBrains Mono at the sizes used)
W={'mono':6.9,'s':6.9,'lbl':5.9,'t':7.4,'acc':7.4,'new-t':7.4,'warn':5.9,'cut':5.9,'':6.6}
def width(txt,cls):
    cls=cls.split()
    k=next((c for c in ['mono','s','t','acc','new-t','lbl','warn','cut'] if c in cls),'')
    # .s in dataflow/arch = mono 11px; in ecosystem .s is sans 12px -> handled by caller
    return len(txt)*W[k]
def check(path, s_is_mono=True):
    src=open(path).read()
    out=[]
    for si,svg in enumerate(re.finditer(r'<svg[^>]*viewBox="0 0 (\d+) (\d+)"[^>]*>(.*?)</svg>',src,re.S)):
        vw=int(svg.group(1)); body=svg.group(3)
        rects=[(float(m.group(1)),float(m.group(2)),float(m.group(3)),float(m.group(4))) for m in re.finditer(r'<rect[^>]*?x="([\d.]+)"[^>]*?y="([\d.]+)"[^>]*?width="([\d.]+)"[^>]*?height="([\d.]+)"',body)]
        for m in re.finditer(r'<text([^>]*)>(.*?)</text>',body,re.S):
            attrs=m.group(1); txt=html.unescape(re.sub(r'<[^>]+>','',m.group(2)))
            x=float(re.search(r'x="([\d.]+)"',attrs).group(1)); y=float(re.search(r'y="([\d.]+)"',attrs).group(1))
            cls=(re.search(r'class="([^"]*)"',attrs) or [None,''])[1]
            anchor=(re.search(r'text-anchor="(\w+)"',attrs) or [None,'start'])[1]
            w=width(txt,cls if (s_is_mono or 's' not in cls.split()) else cls.replace('s','lbl'))
            x0 = x if anchor=='start' else (x-w if anchor=='end' else x-w/2)
            x1 = x0+w
            # containing rect = smallest rect containing (x,y)
            cont=[r for r in rects if r[0]<=x<=r[0]+r[2] and r[1]<=y<=r[1]+r[3]]
            if cont:
                r=min(cont,key=lambda r:r[2]*r[3])
                if x1>r[0]+r[2]-4 or x0<r[0]+2:
                    out.append(f'  svg#{si+1} y={y:.0f} overflows box(w={r[2]:.0f}) by {x1-(r[0]+r[2]):.0f}px: {txt[:70]}')
            if x1>vw-2: out.append(f'  svg#{si+1} y={y:.0f} beyond viewBox by {x1-vw:.0f}px: {txt[:70]}')
    return out
for p in sys.argv[1:]:
    r=check(p, s_is_mono=('ecosystem' not in p))
    print(p, len(r)); print('\n'.join(r))
