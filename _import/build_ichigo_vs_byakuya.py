# -*- coding: utf-8 -*-
"""Ichigo vs Byakuya Bankai → Synchronstudio (DE) + Choicer Voicer mod pack (EN)."""
import json
import shutil
import subprocess
import zipfile
from pathlib import Path

FF = Path(r"C:\Users\mirts\AppData\Local\ss-tools\bin\ffmpeg.exe")
FP = Path(r"C:\Users\mirts\AppData\Local\ss-tools\bin\ffprobe.exe")
SRC = Path(r"C:\Users\mirts\Desktop\Ichigo vs Byakuya Bankai")
ROOT = Path(r"C:\Users\mirts\Projects\synchronstudio")
DESKTOP = Path(r"C:\Users\mirts\Desktop")

SID = "ichigovsbayakuya"
OUT_DIR = ROOT / "scenes" / SID
LINES_DIR = OUT_DIR / "lines"
VIDEO_OUT = ROOT / "scenes" / f"{SID}.mp4"
LIVE_SCENES = ROOT / "_import" / "scenes_live.json"

CV_DIR = DESKTOP / "Ichigo_vs_Byakuya_ChoicerVoicer"
CV_ZIP = DESKTOP / "Ichigo_vs_Byakuya_ChoicerVoicer.zip"

# English captions (light cleanup of Elias's wording; keep spirit)
EN = [
    "*breaths* damn... i thought i could do better than that...",
    "I should've known I couldn't do it... *little breath* just had to try though",
    "*struggling breaths* guess it's foolish to think I could ever beat a bankai while only using my shikai...",
    "That arrogant mouth of yours is going to be the death of you... you talk as if you already achieved bankai level...",
    "Yeahhhhh",
    "Mhm?",
    "You catch on pretty quickly... Byakuya Kuchiki",
    "What did you say?",
    "Don't make me repeat myself... I think you heard me *struggling breath* you just don't want to believe it... do you?",
    "Then again, I don't care whether you believe me or not. I'm not gonna say it again...",
    "You'll believe it once you see it yourself.... Byakuya Kuchiki",
    "*hard step* *scream your lungs out*",
    "*focusing / concentrate sound*",
    "That must be Ichigo... right?",
    "No one else I know fights like that... no one's that crazy...",
    "*nonchalant shock*",
    "Ban...Kai",
    "*Tsk...* (nonchalant)",
    "Tensa Zangetsu...",
]

# Natural German for Synchronstudio
DE = [
    "*atmet* verdammt... ich dachte, ich könnte das besser...",
    "Ich hätte wissen müssen, dass ich's nicht schaffe... *kurzer Atemzug* musste es aber versuchen",
    "*keucht* naiv zu glauben, ich könnte jemals ein Bankai knacken — und das nur mit meinem Shikai...",
    "Dieses arrogante Maul wird noch dein Tod sein... du redest, als hättest du schon Bankai-Niveau...",
    "Jaaaaaa",
    "Mhm?",
    "Du merkst's ziemlich schnell... Byakuya Kuchiki",
    "Was hast du gesagt?",
    "Lass mich das nicht wiederholen... ich denk, du hast mich gehört *keucht* du willst es nur nicht glauben... oder?",
    "Andererseits ist mir egal, ob du mir glaubst oder nicht. Ich sag's nicht nochmal...",
    "Du glaubst es, wenn du es selbst siehst.... Byakuya Kuchiki",
    "*harter Schritt* *schrei dir die Seele aus dem Leib*",
    "*Konzentrationsgeräusch*",
    "Das muss Ichigo sein... oder?",
    "Niemand sonst, den ich kenne, kämpft so... niemand ist so verrückt...",
    "*lässiger Schock*",
    "Ban...Kai",
    "*Tsk...* (lässig)",
    "Tensa Zangetsu...",
]

ROLES = [
    {"id": 0, "name": "Ichigo", "pan": -0.2, "effect": "none", "gain": 1.05},
    {"id": 1, "name": "Byakuya", "pan": 0.25, "effect": "none", "gain": 1.0},
    {"id": 2, "name": "Orihime", "pan": -0.4, "effect": "none", "gain": 1.0},
    {"id": 3, "name": "Uryu", "pan": 0.4, "effect": "none", "gain": 1.0},
]

WHO_TO_ROLE = {"Ichigo": 0, "Byakuya": 1, "Orihime": 2, "Uryu": 3}
AVATAR_SRC = {
    "Ichigo": SRC / "Ichigo.jpg",
    "Byakuya": SRC / "Byakuya.jpg",
    "Orihime": SRC / "Orihime.jpg",
    "Uryu": SRC / "Uryu.jpg",
}


def run(cmd, **kw):
    print("+", " ".join(str(c) for c in cmd[:8]), "...")
    subprocess.run(cmd, check=True, **kw)


def probe_dur(path: Path) -> float:
    out = subprocess.check_output(
        [str(FP), "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        text=True,
    ).strip()
    return float(out)


def main():
    assert LIVE_SCENES.exists(), "missing live scenes.json — download first"
    meta = json.loads((SRC / "scenes.txt").read_text(encoding="utf-8"))
    lines_in = meta["lines"]
    assert len(lines_in) == len(EN) == len(DE), (len(lines_in), len(EN), len(DE))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    LINES_DIR.mkdir(parents=True, exist_ok=True)
    if CV_DIR.exists():
        shutil.rmtree(CV_DIR)
    CV_DIR.mkdir(parents=True)

    # --- avatars ---
    avatars = {}
    for who, src in AVATAR_SRC.items():
        rid = WHO_TO_ROLE[who]
        dest = OUT_DIR / f"{who.lower()}.png"
        run([str(FF), "-y", "-i", str(src), "-vf", "scale=160:-1", str(dest)])
        avatars[str(rid)] = f"scenes/{SID}/{who.lower()}.png"
        # CV shared character image
        run([str(FF), "-y", "-i", str(src), "-vf", "scale=256:-1", str(CV_DIR / f"{who}.png")])

    # --- backing track mp3 ---
    backing_mp3 = OUT_DIR / "_backing_track.mp3"
    run([
        str(FF), "-y", "-i", str(SRC / "backingtrack.mp4"),
        "-vn", "-ac", "2", "-b:a", "128k", str(backing_mp3),
    ])
    shutil.copy2(backing_mp3, CV_DIR / "_backing_track.mp3")

    # --- game video: video + backing only ---
    run([
        str(FF), "-y",
        "-i", str(SRC / "dub_video.mp4"),
        "-i", str(backing_mp3),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "fast", "-crf", "28",
        "-vf", "scale=1280:-2",
        "-c:a", "aac", "-b:a", "96k",
        "-shortest",
        "-movflags", "+faststart",
        str(VIDEO_OUT),
    ])
    src_dur = probe_dur(SRC / "dub_video.mp4")
    out_dur = probe_dur(VIDEO_OUT)
    print(f"duration src={src_dur:.3f} out={out_dur:.3f} delta={abs(src_dur-out_dur):.3f}")
    assert abs(src_dur - out_dur) < 1.5, "video duration mismatch"
    vsize = VIDEO_OUT.stat().st_size / (1024 * 1024)
    print(f"video size: {vsize:.2f} MB")
    if vsize > 15:
        print("WARN: video > 15MB — re-encoding smaller")
        tmp = VIDEO_OUT.with_suffix(".tmp.mp4")
        run([
            str(FF), "-y",
            "-i", str(SRC / "dub_video.mp4"),
            "-i", str(backing_mp3),
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
            "-vf", "scale=854:-2",
            "-c:a", "aac", "-b:a", "80k",
            "-shortest",
            "-movflags", "+faststart",
            str(tmp),
        ])
        tmp.replace(VIDEO_OUT)
        print(f"resized: {VIDEO_OUT.stat().st_size / (1024*1024):.2f} MB")

    # CV dub_video: keep voices (Theora/Vorbis .ogv for Choicer Voicer Dub Mode)
    run([
        str(FF), "-y", "-i", str(SRC / "dub_video.mp4"),
        "-c:v", "libtheora", "-q:v", "7",
        "-vf", "scale=1280:-2",
        "-c:a", "libvorbis", "-q:a", "4",
        str(CV_DIR / "dub_video.ogv"),
    ])

    # Icon from Ichigo
    run([str(FF), "-y", "-i", str(SRC / "Ichigo.jpg"), "-vf", "scale=256:-1", str(CV_DIR / "Icon.png")])

    # --- slice vocals into line mp3s ---
    vocals = SRC / "Vocals.mp4"
    scene_lines = []
    char_counts = {"Ichigo": 0, "Byakuya": 0, "Orihime": 0, "Uryu": 0}

    for i, (raw, en, de) in enumerate(zip(lines_in, EN, DE), start=1):
        who = raw["who"]
        rid = WHO_TO_ROLE[who]
        t = float(raw["t"])
        end = float(raw["end"])
        dur = max(0.15, end - t)
        num = f"{i:02d}"
        line_mp3 = LINES_DIR / f"{num}.mp3"
        run([
            str(FF), "-y", "-ss", f"{t:.3f}", "-i", str(vocals),
            "-t", f"{dur:.3f}",
            "-ac", "1", "-b:a", "64k",
            str(line_mp3),
        ])

        # CV line files — sequential with character name
        char_counts[who] += 1
        cv_base = f"{num}_{who}"
        cv_mp3 = CV_DIR / f"{cv_base}.mp3"
        shutil.copy2(line_mp3, cv_mp3)
        # shared char png already exists; also copy per-line alias some packs expect
        shutil.copy2(CV_DIR / f"{who}.png", CV_DIR / f"{cv_base}.png")
        txt = (
            "[data]\n\n"
            f'caption="{en.replace(chr(34), chr(39))}"\n'
            f'image="{who}.png"\n'
            f"dub_timestamps=[{t:.3f}]\n"
            f'dub_characters=["{who}"]\n'
        )
        (CV_DIR / f"{cv_base}.txt").write_text(txt, encoding="utf-8")

        scene_lines.append({
            "t": round(t, 3),
            "end": round(end, 3),
            "chars": [rid],
            "who": who,
            "text": en,
            "de": de,
            "orig": f"scenes/{SID}/lines/{num}.mp3",
        })

    pack_info = (
        "[data]\n\n"
        'title="Ichigo vs Byakuya Bankai"\n'
        'subtitle="Bleach — Ichigo vs Byakuya"\n'
        'icon="Icon.png"\n'
        'authors=["Elias"]\n'
        'readme="Ichigo vs Byakuya Bankai scene pack for Choicer Voicer."\n'
    )
    (CV_DIR / "_pack_info.ini").write_text(pack_info, encoding="utf-8")

    # Zip CV pack (folder as root)
    if CV_ZIP.exists():
        CV_ZIP.unlink()
    with zipfile.ZipFile(CV_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(CV_DIR.rglob("*")):
            if f.is_file():
                zf.write(f, arcname=str(Path(CV_DIR.name) / f.relative_to(CV_DIR)))
    print("CV zip:", CV_ZIP, CV_ZIP.stat().st_size / (1024 * 1024), "MB")

    scene = {
        "id": SID,
        "title": "Bleach — Ichigo vs Byakuya Bankai (4 Rollen)",
        "videoUrl": f"scenes/{SID}.mp4",
        "avatars": avatars,
        "roles": ROLES,
        "lines": scene_lines,
        "difficultyOverride": "medium",
    }

    # Merge into LIVE scenes.json
    scenes = json.loads(LIVE_SCENES.read_text(encoding="utf-8"))
    scenes = [s for s in scenes if s.get("id") != SID]
    scenes.append(scene)
    (ROOT / "scenes.json").write_text(
        json.dumps(scenes, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    print("scenes.json count:", len(scenes))

    # Verify files
    missing = []
    for p in [VIDEO_OUT] + [OUT_DIR / f"{w.lower()}.png" for w in AVATAR_SRC] + [
        LINES_DIR / f"{i:02d}.mp3" for i in range(1, len(scene_lines) + 1)
    ]:
        if not p.exists():
            missing.append(str(p))
    if missing:
        raise SystemExit("missing files: " + ", ".join(missing))

    # Patch client.js: APP_VERSION, AVATAR_CHARS, PATCH_NOTES
    client_path = ROOT / "client.js"
    client = client_path.read_text(encoding="utf-8")
    ver_m = __import__("re").search(r'const APP_VERSION = "([^"]+)"', client)
    if not ver_m:
        raise SystemExit("APP_VERSION not found")
    old_ver = ver_m.group(1)
    parts = old_ver.split(".")
    parts[-1] = str(int(parts[-1]) + 1)
    new_ver = ".".join(parts)
    client = client.replace(
        f'const APP_VERSION = "{old_ver}"',
        f'const APP_VERSION = "{new_ver}"',
    )

    avatar_block = (
        '  { img: "scenes/yujitodohanami/gojo.png", label: "Gojo (vs Hanami)" },\n'
        '  { img: "scenes/profiles/kayleen.png", label: "Kayleen" },'
    )
    avatar_insert = (
        '  { img: "scenes/yujitodohanami/gojo.png", label: "Gojo (vs Hanami)" },\n'
        '  { img: "scenes/ichigovsbayakuya/ichigo.png", label: "Ichigo" },\n'
        '  { img: "scenes/ichigovsbayakuya/byakuya.png", label: "Byakuya" },\n'
        '  { img: "scenes/ichigovsbayakuya/orihime.png", label: "Orihime" },\n'
        '  { img: "scenes/ichigovsbayakuya/uryu.png", label: "Uryu" },\n'
        '  { img: "scenes/profiles/kayleen.png", label: "Kayleen" },'
    )
    if "scenes/ichigovsbayakuya/ichigo.png" not in client:
        if avatar_block not in client:
            raise SystemExit("AVATAR_CHARS anchor not found")
        client = client.replace(avatar_block, avatar_insert, 1)

    note = (
        f'  {{ v: "{new_ver}", items: [\n'
        '    "🎬 Neue Szene: Bleach — Ichigo vs Byakuya Bankai (Ichigo, Byakuya, Orihime, Uryu)"\n'
        "  ]},\n"
    )
    if f'v: "{new_ver}"' not in client:
        client = client.replace("const PATCH_NOTES = [\n", "const PATCH_NOTES = [\n" + note, 1)

    client_path.write_text(client, encoding="utf-8")

    html_path = ROOT / "index.html"
    html = html_path.read_text(encoding="utf-8")
    html2 = __import__("re").sub(
        r'client\.js\?v=[0-9.]+',
        f"client.js?v={new_ver}",
        html,
        count=1,
    )
    html_path.write_text(html2, encoding="utf-8")

    print("VERSION", old_ver, "->", new_ver)
    print("lines", len(scene_lines))
    print("DONE")


if __name__ == "__main__":
    main()
