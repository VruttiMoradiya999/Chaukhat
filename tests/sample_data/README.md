# Sample Data Directory

Place your sample smartphone video or photos here to test the Chaukhat 3D Gaussian Splatting pipeline.

## Supported Formats

1. **Smartphone Video**:
   - Files with extension `.mp4`, `.mov`, or `.m4v`.
   - Example: `tests/sample_data/living_room.mp4`

2. **Zip of Photos**:
   - A `.zip` archive containing photos (`.jpg`, `.jpeg`, `.png`, `.heic`).
   - Example: `tests/sample_data/room_photos.zip`

---

## Best Practices for Recording Indoor Spaces

To ensure COLMAP successfully estimates camera poses and Nerfstudio trains high-fidelity splats:

1. **Move Slower Than You Think**:
   - Fast pans and quick turns introduce severe motion blur, which causes feature matching (COLMAP) to fail.
   - Walk slowly and smoothly around the room.

2. **Ensure High Visual Overlap (70–80%)**:
   - Each consecutive frame or photo should share 70% to 80% visual field-of-view with the previous one.
   - For video, 15 to 45 seconds of continuous scanning is usually plenty (yielding 30–90 frames at 2 FPS).

3. **Lighting & Reflections**:
   - Turn on indoor lights so the scene is bright and evenly lit.
   - Avoid pointing the camera directly into glaring lights, mirrors, or featureless plain white walls where feature matchers cannot find contrast.

4. **Loop Closures**:
   - If walking around an object or room, return close to where you started so COLMAP can lock the trajectory into a cohesive 360° structure.
