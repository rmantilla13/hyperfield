# Feature comparison

How OpenField's apps line up with Higgsfield's feature areas. Higgsfield's list
comes from its public product pages, help center and changelog, read on
2026-10-17. OpenField's column is the current branch.

- **have**: an OpenField app does this today.
- **partial**: some of it ships; the note says what.
- **not yet**: nothing in OpenField yet.
- **OpenField only**: no matching feature at Higgsfield as of the date above.

## Create

| Feature area | OpenField | Status | Note |
| --- | --- | --- | --- |
| Text and image to video, aspect, resolution, native audio | Video | have | 3 to 10 s, 720p by default (480p to 1080p), batch 1 to 4 |
| Start and end frame | Video | have | |
| Reference images in a video | Cast | partial | Up to 6 pictures per cast member on an LTX-2.5 reference sheet; no video or audio references |
| Keyframes (3 or more stills) | | not yet | Two frames only (start and end) |
| Motion and effect presets | Video, Effects | partial | 28 motion presets and 11 LoRA effects, each with a rendered preview |
| Named camera moves, stacked | Video, Director, Stage | partial | One preset move per shot; Stage draws any camera path |
| Draw strokes to steer motion | | not yet | |
| Image generation | Image | have | Qwen-Image, optional FLUX.2 |
| Image edit and inpaint | Edit | have | Instruction edits with a painted mask, up to 3 input images |
| Storyboard | Coverage, Next beat, Scene | partial | Shot grids and continuations from one image; Scene plans a shot list |
| Sound effects for a silent clip | Add sound | have | LTX-2.5 video to audio |
| Text to speech, voice clone, music | | not yet | |
| Image to 3D | Object | have | TRELLIS.2 GLB with PBR maps and a turntable |

## Direct

| Feature area | OpenField | Status | Note |
| --- | --- | --- | --- |
| Director panel: camera, lens, light, film stock, look, grade | Director | have | |
| Genres | Director | have | 7 genres that pre-fill the other axes |
| Era scrubber | Director | have | 1960 to 2020, graded on the output |
| Speed ramps | Director | have | Slow-mo, Ramp up, Impact, Bullet time |
| Multi-shot sequence from a script | Scene | have | Local LLM plans 2 to 6 shots, rendered and cut into one take |
| Characters and places in shots | Cast | have | `@mentions` in any prompt |
| Emotion control | | not yet | |
| Color grades | Director | partial | Grade presets and the era grade; no palette or LUT import |
| Extend inside a shot | Extend | have | Forward or as a lead-in |
| 3D scene staged and rendered | Stage | have | Greybox blocking and Object models render through LTX-2.5 Layout-to-Render |
| Region edit on a video | | not yet | |

## Transform

| Feature area | OpenField | Status | Note |
| --- | --- | --- | --- |
| Motion transfer from a clip | Mirror | have | Pose, depth or edges; phone capture by QR code |
| Restyle a clip | Mirror > Restyle | have | 22 looks or your own words |
| Swap an object in a clip | Mirror > Object swap | partial | Experimental; works on objects, loses a moving person's action |
| Character swap in a clip | Mirror, Cast | partial | A composed first frame of a cast member carried through Mirror |
| Face swap | | not yet | |
| New angle on a still | New angle | have | |
| Nine shots from one image | Coverage | have | |
| Zoom steps on a still | Push in | have | |
| What happens next | Next beat | have | Four continuations |
| Relight a still | Relight | have | |
| Relight a clip | | not yet | |
| Expand a still | Expand | have | |
| Expand or reframe a clip | | not yet | |
| Background removal, still and clip | Remove background | have | PNG, ProRes 4444 with alpha, or a new background |
| Remove objects from a clip | Effects > Empty the scene | partial | Clean plate of the whole scene; no per-object mask |
| Talking photo from audio | Speak | have | LTX-2.5 audio to video |
| Lip sync on an existing clip, translate and dub | | not yet | |
| Beat-cut edit from photos | | not yet | |
| Camera move on an existing clip | Reshoot | OpenField only | |

## Finish

| Feature area | OpenField | Status | Note |
| --- | --- | --- | --- |
| Video upscale | Upscale | have | Sharpen 2x, Redraw to 1080p or 1440p, Dream 2x |
| Image upscale | Upscale | have | |
| Frame interpolation | Upscale > Sharpen | have | RIFE frame doubling |
| Extend forward and backward | Extend | have | |
| Transitions between two shots | Transitions | have | 8 styles |
| HDR and EXR masters | Finish in HDR | OpenField only | ACEScg EXR, HLG HEVC, HLG ProRes |
| Loop seam check and fix | Improve the seam | OpenField only | |

## Identity

| Feature area | OpenField | Status | Note |
| --- | --- | --- | --- |
| Saved characters, props and places | Cast | have | |
| Consistent character across apps | Cast | have | Stills, video, Mirror, Speak and Scene |
| Train an identity model from photos | | not yet | |
| Character builder and turnaround sheet | | not yet | |

## Platform

| Feature area | OpenField | Status | Note |
| --- | --- | --- | --- |
| Asset library with filters and favorites | Library | have | All, image, video, 3D, favorites |
| Actions on any asset | Viewer | have | Animate, edit, extend, upscale, loop, HDR and more |
| Recreate a result | Viewer | have | Same graph, seed included |
| Apps gallery | Apps | have | 24 apps in 4 groups |
| Queue and history | Queue | have | Live progress, cancel, time estimates |
| MCP for agents | MCP server | have | 31 tools, runs locally |
| REST API | Server | partial | The local HTTP API the app uses; no published spec yet |
| CLI and agent skills | | not yet | |
| Node canvas | Open in ComfyUI | partial | Every take opens in ComfyUI as a node graph |
| Workflow export per result | Viewer, `workflows/` | OpenField only | |
| Runs on your own GPU, no credits | | OpenField only | |
| Ad, marketing and shorts studios | | not yet | Out of scope for now |
| Plugins for desktop tools | | not yet | |
