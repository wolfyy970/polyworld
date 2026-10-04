/**
 * Lane W1e — golden vectors generated from the NATIVE code path, do not edit.
 *
 * Produced by `src/model/geometry/native/glprobe.sh` (see glprobe.cpp): the values
 * come from the real `gcamera`/`gpoint`/`gpolyobj`/`frustumXZ` objects linked out
 * of the native build's `libpolyworld.dylib`, driving the same fixed-function GL
 * (Apple OpenGL + GLU) the oracle binary links:
 *
 *   gl.version: 2.1 Metal - 90.5
 *   gl.renderer: Apple M3 Ultra
 *   glu.version: 1.3 MacOSX
 *
 * `f32`/`mat4` entries keep the exact float32 bit pattern the native side produced;
 * `f64` entries are the native-side double computations (frustum planes, eye point).
 * The `*FIXTURES` lists are the inputs those vectors were generated from, so a test
 * can replay each case through the port instead of duplicating the constants.
 */

/** Hardware/implementation the goldens were recorded on. */
export const GOLDEN_ENVIRONMENT = {
  glVersion: '2.1 Metal - 90.5',
  glRenderer: 'Apple M3 Ultra',
  gluVersion: '1.3 MacOSX',
} as const;

/** Native float32 results (bit-exact: rebuilt from the recorded bits). */
export const GOLDEN_F32: Readonly<Record<string, readonly number[]>> = {
  'frustumQ.neg200_fov20': [0, 0, 2.6179938316345215, -9.599310874938965],
  'frustumQ.yaw350_fov140': [0, 0, -1.3962634801864624, 1.0471973419189453],
  'frustumQ.yaw90_fov180': [0, 0, 0, 3.141592502593994],
  'frustumQ.yaw45_fov360': [0, 0, -2.356194496154785, 10.210176467895508],
  'frustumQ.yaw0_fov0': [0, 0, 0, 0],
  'frustumQ.yaw180_fov140': [3.0, -4.0, 1.919862151145935, -1.919862151145935],
  'frustumQ.rad0.5': [4.388930797576904, -5.326351642608643, -0.1745329201221466, 1.2217304706573486],
  'frustumQ.rad1': [4.777862071990967, -4.652703762054443, -0.1745329201221466, 1.2217304706573486],
  'frustumQ.rad2.5': [5.944654941558838, -2.63175892829895, -0.1745329201221466, 1.2217304706573486],
  'polyobj.length': [1.25, 1.0, 2.0],
  'polyobj.radius': [1.2808688879013062],
  'polyobj.radius.scale2': [2.5617377758026123],
  'polyobj.radius.radiusscale3': [7.685213088989258],
  'polyobj.radius.fixed': [4.0],
  'minitest_a10_focus_min.aspect': [2.0],
  'minitest_a10_focus_min.fovx': [20.0],
  'minitest_a10_focus_min.fov': [10.0],
  'minitest_a10_focus_min.frustumXZ': [15.350000381469727, -16.719999313354492, 0.6108652353286743, 0.9599310755729675],
  'minitest_a10_focus_min.frustumXZ.rad1': [19.42206573486328, -12.647933006286621, 0.6108652353286743, 0.9599310755729675],
  'minitest_a10_focus_mid.aspect': [8.0],
  'minitest_a10_focus_mid.fovx': [80.0],
  'minitest_a10_focus_mid.fov': [10.0],
  'minitest_a10_focus_mid.frustumXZ': [15.350000381469727, -16.719999313354492, 0.0872664600610733, 1.483529806137085],
  'minitest_a10_focus_mid.frustumXZ.rad1': [16.450063705444336, -15.619935989379883, 0.0872664600610733, 1.483529806137085],
  'minitest_a10_focus_max.aspect': [14.0],
  'minitest_a10_focus_max.fovx': [140.0],
  'minitest_a10_focus_max.fov': [10.0],
  'minitest_a10_focus_max.frustumXZ': [15.350000381469727, -16.719999313354492, -0.4363322854042053, 2.0071284770965576],
  'minitest_a10_focus_max.frustumXZ.rad1': [16.102487564086914, -15.967512130737305, -0.4363322854042053, 2.0071284770965576],
  'vision_pitch_yaw.aspect': [5.0],
  'vision_pitch_yaw.fovx': [50.0],
  'vision_pitch_yaw.fov': [10.0],
  'vision_pitch_yaw.frustumXZ': [15.350000381469727, -16.719999313354492, 0.3490658402442932, 1.2217304706573486],
  'vision_pitch_yaw.frustumXZ.rad1': [17.023157119750977, -15.046841621398926, 0.3490658402442932, 1.2217304706573486],
  'wrap_yaw170_fov140.aspect': [14.0],
  'wrap_yaw170_fov140.fovx': [140.0],
  'wrap_yaw170_fov140.fov': [10.0],
  'wrap_yaw170_fov140.frustumXZ': [8.0, -8.0, 1.7453291416168213, -2.094395399093628],
  'wrap_yaw170_fov140.frustumXZ.rad1': [8.184792518615723, -9.04801082611084, 1.7453291416168213, -2.094395399093628],
  'world100_origin.aspect': [8.0],
  'world100_origin.fovx': [80.0],
  'world100_origin.fov': [10.0],
  'world100_origin.frustumXZ': [0, 0, -0.6981316804885864, 0.6981316804885864],
  'world100_origin.frustumXZ.rad1': [0, 1.5557239055633545, -0.6981316804885864, 0.6981316804885864],
};

/** Native 4x4 matrices, GL column-major (16 entries). */
export const GOLDEN_MAT4: Readonly<Record<string, readonly number[]>> = {
  'gl.translate': [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 1.5, -2.25, 0.125, 1.0],
  'gl.rotatef.y.45': [0.7071067690849304, 0, -0.7071067690849304, 0, 0, 1.0, 0, 0, 0.7071067690849304, 0, 0.7071067690849304, 0, 0, 0, 0, 1.0],
  'gl.rotatef.x.45': [1.0, 0, 0, 0, 0, 0.7071067690849304, 0.7071067690849304, 0, 0, -0.7071067690849304, 0.7071067690849304, 0, 0, 0, 0, 1.0],
  'gl.rotatef.z.45': [0.7071067690849304, 0.7071067690849304, 0, 0, -0.7071067690849304, 0.7071067690849304, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0],
  'gl.rotatef.y.90': [-4.371138828673793e-08, -0, -1.0, -0, 0, 1.0, 0, 0, 1.0, 0, -4.371138828673793e-08, 0, 0, 0, 0, 1.0],
  'gl.rotatef.x.90': [1.0, 0, 0, 0, 0, -4.371138828673793e-08, 1.0, 0, -0, -1.0, -4.371138828673793e-08, -0, 0, 0, 0, 1.0],
  'gl.rotatef.z.90': [-4.371138828673793e-08, 1.0, 0, 0, -1.0, -4.371138828673793e-08, -0, -0, 0, 0, 1.0, 0, 0, 0, 0, 1.0],
  'gl.rotatef.y.-90': [-4.371138828673793e-08, 0, 1.0, 0, 0, 1.0, 0, 0, -1.0, -0, -4.371138828673793e-08, -0, 0, 0, 0, 1.0],
  'gl.rotatef.x.-90': [1.0, 0, 0, 0, -0, -4.371138828673793e-08, -1.0, -0, 0, 1.0, -4.371138828673793e-08, 0, 0, 0, 0, 1.0],
  'gl.rotatef.z.-90': [-4.371138828673793e-08, -1.0, -0, -0, 1.0, -4.371138828673793e-08, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0],
  'gl.rotatef.y.30': [0.8660253882408142, 0, -0.5, 0, 0, 1.0, 0, 0, 0.5, 0, 0.8660253882408142, 0, 0, 0, 0, 1.0],
  'gl.rotatef.x.30': [1.0, 0, 0, 0, 0, 0.8660253882408142, 0.5, 0, 0, -0.5, 0.8660253882408142, 0, 0, 0, 0, 1.0],
  'gl.rotatef.z.30': [0.8660253882408142, 0.5, 0, 0, -0.5, 0.8660253882408142, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0],
  'gl.rotatef.y.7.5': [0.9914448857307434, 0, -0.13052619993686676, 0, 0, 1.0, 0, 0, 0.13052619993686676, 0, 0.9914448857307434, 0, 0, 0, 0, 1.0],
  'gl.rotatef.x.7.5': [1.0, 0, 0, 0, 0, 0.9914448857307434, 0.13052619993686676, 0, 0, -0.13052619993686676, 0.9914448857307434, 0, 0, 0, 0, 1.0],
  'gl.rotatef.z.7.5': [0.9914448857307434, 0.13052619993686676, 0, 0, -0.13052619993686676, 0.9914448857307434, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0],
  'gl.rotatef.y.180': [-1.0, 0, 8.742277657347586e-08, 0, 0, 1.0, 0, 0, -8.742277657347586e-08, -0, -1.0, -0, 0, 0, 0, 1.0],
  'gl.rotatef.x.180': [1.0, 0, 0, 0, -0, -1.0, -8.742277657347586e-08, -0, 0, 8.742277657347586e-08, -1.0, 0, 0, 0, 0, 1.0],
  'gl.rotatef.z.180': [-1.0, -8.742277657347586e-08, -0, -0, 8.742277657347586e-08, -1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0],
  'gl.gluPerspective.10.2.0.01.37.5': [5.715025901794434, 0, 0, 0, 0, 11.430051803588867, 0, 0, 0, 0, -1.0005334615707397, -1.0, -0, -0, -0.02000533416867256, -0],
  'gl.gluPerspective.10.3.0.01.37.5': [3.8100175857543945, 0, 0, 0, 0, 11.430051803588867, 0, 0, 0, 0, -1.0005334615707397, -1.0, -0, -0, -0.02000533416867256, -0],
  'gl.gluPerspective.10.5.0.01.37.5': [2.286010503768921, 0, 0, 0, 0, 11.430051803588867, 0, 0, 0, 0, -1.0005334615707397, -1.0, -0, -0, -0.02000533416867256, -0],
  'gl.gluPerspective.10.8.0.01.37.5': [1.4287564754486084, 0, 0, 0, 0, 11.430051803588867, 0, 0, 0, 0, -1.0005334615707397, -1.0, -0, -0, -0.02000533416867256, -0],
  'gl.gluPerspective.10.14.0.01.37.5': [0.8164322972297668, 0, 0, 0, 0, 11.430051803588867, 0, 0, 0, 0, -1.0005334615707397, -1.0, -0, -0, -0.02000533416867256, -0],
  'gl.gluPerspective.10.1.0.01.37.5': [11.430051803588867, 0, 0, 0, 0, 11.430051803588867, 0, 0, 0, 0, -1.0005334615707397, -1.0, -0, -0, -0.02000533416867256, -0],
  'gl.gluPerspective.90.1.1e-05.10000': [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, -1.0, -1.0, -0, -0, -1.9999999494757503e-05, -0],
  'gl.identity': [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0],
  'obj.yaw45': [0.7071067690849304, 0, -0.7071067690849304, 0, 0, 1.0, 0, 0, 0.7071067690849304, 0, 0.7071067690849304, 0, 1.0, 0.5, -2.0, 1.0],
  'obj.yaw30_pitch-15_roll10': [1.6607935428619385, 0.3354625105857849, -1.0626521110534668, 0, -0.5556544661521912, 1.902502417564392, -0.267829030752182, 0, 0.9659258127212524, 0.517638087272644, 1.673032522201538, 0, -3.25, 0, 7.5, 1.0],
  'obj.unrotated': [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 5.0, 2.0, 0, 1.0],
  'obj.rotated_zero_angles': [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 5.0, 2.0, 0, 1.0],
  'gcamera.use65_aspect1.modelview': [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, -3.0, -4.0, -5.0, 1.0],
  'gcamera.use65_aspect1.projection': [1.5696855783462524, 0, 0, 0, 0, 1.5696855783462524, 0, 0, 0, 0, -1.007843255996704, -1.0, -0, -0, -0.501960813999176, -0],
  'gcamera.fixPerspective.projection': [1.299038052558899, 0, 0, 0, 0, 1.732050895690918, 0, 0, 0, 0, -1.0645160675048828, -1.0, -0, -0, -1.0322580337524414, -0],
  'gcamera.fixPerspective.modelview': [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 1.0, 0, -2.0, 1.0],
  'gcamera.fixPerspective.projectionAfterUse': [1.299038052558899, 0, 0, 0, 0, 1.732050895690918, 0, 0, 0, 0, -1.0645160675048828, -1.0, -0, -0, -1.0322580337524414, -0],
  'gl.obj->minitest_a10_focus_min.projection': [5.715025901794434, 0, 0, 0, 0, 11.430051803588867, 0, 0, 0, 0, -1.0005334615707397, -1.0, -0, -0, -0.02000533416867256, -0],
  'gl.obj->minitest_a10_focus_min.modelview': [0.7071067690849304, 0, 0.7071067690849304, 0, 0, 1.0, 0, 0, -0.7071067690849304, 0, 0.7071067690849304, 0, -22.67691421508789, -0.10000000149011612, 1.468735933303833, 1.0],
  'gl.obj->minitest_a10_focus_mid.projection': [1.4287564754486084, 0, 0, 0, 0, 11.430051803588867, 0, 0, 0, 0, -1.0005334615707397, -1.0, -0, -0, -0.02000533416867256, -0],
  'gl.obj->minitest_a10_focus_mid.modelview': [0.7071067690849304, 0, 0.7071067690849304, 0, 0, 1.0, 0, 0, -0.7071067690849304, 0, 0.7071067690849304, 0, -22.67691421508789, -0.10000000149011612, 1.468735933303833, 1.0],
  'gl.obj->minitest_a10_focus_max.projection': [0.8164322972297668, 0, 0, 0, 0, 11.430051803588867, 0, 0, 0, 0, -1.0005334615707397, -1.0, -0, -0, -0.02000533416867256, -0],
  'gl.obj->minitest_a10_focus_max.modelview': [0.7071067690849304, 0, 0.7071067690849304, 0, 0, 1.0, 0, 0, -0.7071067690849304, 0, 0.7071067690849304, 0, -22.67691421508789, -0.10000000149011612, 2.193480968475342, 1.0],
  'gl.obj->vision_pitch_yaw.projection': [2.286010503768921, 0, 0, 0, 0, 11.430051803588867, 0, 0, 0, 0, -1.0005334615707397, -1.0, -0, -0, -0.02000533416867256, -0],
  'gl.obj->vision_pitch_yaw.modelview': [1.2688051498344066e-08, -0.06540313363075256, 0.9978588819503784, 0, 0, 0.9978589415550232, 0.06540313363075256, 0, -0.9999999403953552, 1.4711871720862746e-09, 1.1976684533010484e-08, 0, -17.07355308532715, 0.8810287117958069, -14.970877647399902, 1.0],
  'gl.obj->wrap_yaw170_fov140.projection': [0.8164322972297668, 0, 0, 0, 0, 11.430051803588867, 0, 0, 0, 0, -1.0005334615707397, -1.0, -0, -0, -0.02000533416867256, -0],
  'gl.obj->wrap_yaw170_fov140.modelview': [-0.9848077297210693, 0, 0.17364829778671265, 0, 0, 1.0, 0, 0, -0.17364829778671265, -0, -0.9848077297210693, -0, 6.4892754554748535, -0.10000000149011612, -8.767648696899414, 1.0],
  'gl.obj->world100_origin.projection': [1.4287564754486084, 0, 0, 0, 0, 11.430051803588867, 0, 0, 0, 0, -1.0001332759857178, -1.0, -0, -0, -0.020001333206892014, -0],
  'gl.obj->world100_origin.modelview': [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, -0.10000000149011612, 0.25, 1.0],
};

/** Native double results. */
export const GOLDEN_F64: Readonly<Record<string, readonly number[]>> = {
  'minitest_a10_focus_min.eyePlanes.left': [0.9850342578871556, 0, -0.17235866902683142, 0],
  'minitest_a10_focus_min.eyePlanes.right': [-0.9850342578871556, 0, -0.17235866902683142, 0],
  'minitest_a10_focus_min.eyePlanes.bottom': [0, 0.9961946977612705, -0.08715574652500525, 0],
  'minitest_a10_focus_min.eyePlanes.top': [0, -0.9961946977612705, -0.08715574652500525, 0],
  'minitest_a10_focus_min.eyePlanes.near': [0, 0, -1.0, -0.009999999776542185],
  'minitest_a10_focus_min.eyePlanes.far': [0, 0, 1.0, 37.50098463687151],
  'minitest_a10_focus_min.worldPlanes.left': [0.5746484197879059, 0, -0.8184003871182264, -22.59068712226906],
  'minitest_a10_focus_min.worldPlanes.right': [-0.8184003871182264, 0, 0.5746484197879059, 22.08438837237187],
  'minitest_a10_focus_min.worldPlanes.bottom': [-0.06162841834049344, 0.9961946978907779, -0.06162841834049344, -0.22762824800536088],
  'minitest_a10_focus_min.worldPlanes.top': [-0.06162841834049344, -0.9961946978907779, -0.06162841834049344, -0.02838930545831374],
  'minitest_a10_focus_min.worldPlanes.near': [-0.7071067811865475, 0, -0.7071067811865475, -1.4787359583878632],
  'minitest_a10_focus_min.worldPlanes.far': [0.7071067811865476, 0, 0.7071067811865476, 38.96972123711372],
  'minitest_a10_focus_min.eyeWorld': [14.996446936316028, 0.10000000149011612, -17.073553248287176],
  'minitest_a10_focus_mid.eyePlanes.left': [0.8192668136424909, 0, -0.573412493815822, 0],
  'minitest_a10_focus_mid.eyePlanes.right': [-0.8192668136424909, 0, -0.573412493815822, 0],
  'minitest_a10_focus_mid.eyePlanes.bottom': [0, 0.9961946977612705, -0.08715574652500525, 0],
  'minitest_a10_focus_mid.eyePlanes.top': [0, -0.9961946977612705, -0.08715574652500525, 0],
  'minitest_a10_focus_mid.eyePlanes.near': [0, 0, -1.0, -0.009999999776542185],
  'minitest_a10_focus_mid.eyePlanes.far': [0, 0, 1.0, 37.50098463687151],
  'minitest_a10_focus_mid.worldPlanes.left': [0.17384525673344378, 0, -0.9847729823219579, -19.420635118881837],
  'minitest_a10_focus_mid.worldPlanes.right': [-0.9847729823219579, 0, 0.17384525673344378, 17.73625202150953],
  'minitest_a10_focus_mid.worldPlanes.bottom': [-0.06162841834049344, 0.9961946978907779, -0.06162841834049344, -0.22762824800536088],
  'minitest_a10_focus_mid.worldPlanes.top': [-0.06162841834049344, -0.9961946978907779, -0.06162841834049344, -0.02838930545831374],
  'minitest_a10_focus_mid.worldPlanes.near': [-0.7071067811865475, 0, -0.7071067811865475, -1.4787359583878632],
  'minitest_a10_focus_mid.worldPlanes.far': [0.7071067811865476, 0, 0.7071067811865476, 38.96972123711372],
  'minitest_a10_focus_mid.eyeWorld': [14.996446936316028, 0.10000000149011612, -17.073553248287176],
  'minitest_a10_focus_max.eyePlanes.left': [0.6324256542593235, 0, -0.7746210633817457, 0],
  'minitest_a10_focus_max.eyePlanes.right': [-0.6324256542593235, 0, -0.7746210633817457, 0],
  'minitest_a10_focus_max.eyePlanes.bottom': [0, 0.9961946977612705, -0.08715574652500525, 0],
  'minitest_a10_focus_max.eyePlanes.top': [0, -0.9961946977612705, -0.08715574652500525, 0],
  'minitest_a10_focus_max.eyePlanes.near': [0, 0, -1.0, -0.009999999776542185],
  'minitest_a10_focus_max.eyePlanes.far': [0, 0, 1.0, 37.50098463687151],
  'minitest_a10_focus_max.worldPlanes.left': [-0.10054733804406023, 0, -0.9949322754902734, -16.040579143890323],
  'minitest_a10_focus_max.worldPlanes.right': [-0.9949322754902734, 0, -0.10054733804406023, 12.642345965116057],
  'minitest_a10_focus_max.worldPlanes.bottom': [-0.06162841834049344, 0.9961946978907779, -0.06162841834049344, -0.2907939425942366],
  'minitest_a10_focus_max.worldPlanes.top': [-0.06162841834049344, -0.9961946978907779, -0.06162841834049344, -0.09155500004718946],
  'minitest_a10_focus_max.worldPlanes.near': [-0.7071067811865475, 0, -0.7071067811865475, -2.203481005962855],
  'minitest_a10_focus_max.worldPlanes.far': [0.7071067811865476, 0, 0.7071067811865476, 39.69446628468871],
  'minitest_a10_focus_max.eyeWorld': [14.483974798544384, 0.10000000149011612, -17.586025386058818],
  'vision_pitch_yaw.eyePlanes.left': [0.9161764064099861, 0, -0.4007752391773773, 0],
  'vision_pitch_yaw.eyePlanes.right': [-0.9161764064099861, 0, -0.4007752391773773, 0],
  'vision_pitch_yaw.eyePlanes.bottom': [0, 0.9961946977612705, -0.08715574652500525, 0],
  'vision_pitch_yaw.eyePlanes.top': [0, -0.9961946977612705, -0.08715574652500525, 0],
  'vision_pitch_yaw.eyePlanes.near': [0, 0, -1.0, -0.009999999776542185],
  'vision_pitch_yaw.eyePlanes.far': [0, 0, 1.0, 37.50098463687151],
  'vision_pitch_yaw.worldPlanes.left': [-0.3999171431911069, -0.026211958014054924, -0.9161764086893599, -9.642429988738566],
  'vision_pitch_yaw.worldPlanes.right': [-0.39991716623915624, -0.026211958000884703, 0.9161763986291084, 21.642344799764736],
  'vision_pitch_yaw.worldPlanes.bottom': [-0.1521233880189643, 0.9883615101862434, 4.217519713811949e-10, 2.182474109967141],
  'vision_pitch_yaw.worldPlanes.top': [-0.021814880440543364, -0.9997620271801508, -2.5094256953126106e-09, 0.4271218783461068],
  'vision_pitch_yaw.worldPlanes.near': [-0.9978589227747927, -0.06540313630652633, -1.1976685023000744e-08, 14.960878259702962],
  'vision_pitch_yaw.worldPlanes.far': [0.9978589227747927, 0.06540313630652633, 1.1976685023000744e-08, 22.53010791122361],
  'vision_pitch_yaw.eyeWorld': [14.99644669948378, 0.10000002669704018, -17.073553912714573],
  'wrap_yaw170_fov140.eyePlanes.left': [0.6324256542593235, 0, -0.7746210633817457, 0],
  'wrap_yaw170_fov140.eyePlanes.right': [-0.6324256542593235, 0, -0.7746210633817457, 0],
  'wrap_yaw170_fov140.eyePlanes.bottom': [0, 0.9961946977612705, -0.08715574652500525, 0],
  'wrap_yaw170_fov140.eyePlanes.top': [0, -0.9961946977612705, -0.08715574652500525, 0],
  'wrap_yaw170_fov140.eyePlanes.near': [0, 0, -1.0, -0.009999999776542185],
  'wrap_yaw170_fov140.eyePlanes.far': [0, 0, 1.0, 37.50098463687151],
  'wrap_yaw170_fov140.worldPlanes.left': [-0.7573293034487242, 0, 0.6530331738417815, 10.895589655196176],
  'wrap_yaw170_fov140.worldPlanes.right': [0.4883060447175573, 0, 0.8726724509759061, 2.68762108693892],
  'wrap_yaw170_fov140.worldPlanes.bottom': [-0.015134447026636333, 0.9961946977770004, 0.08583165286879069, 0.6645314961971781],
  'wrap_yaw170_fov140.worldPlanes.top': [-0.015134447026636333, -0.9961946977770004, 0.08583165286879069, 0.8637704387214697],
  'wrap_yaw170_fov140.worldPlanes.near': [-0.17364829814767627, 0, 0.9848077317681942, 8.757648715327441],
  'wrap_yaw170_fov140.worldPlanes.far': [0.1736482981476763, 0, -0.9848077317681944, 28.733335999700234],
  'wrap_yaw170_fov140.eyeWorld': [7.913175933547641, 0.10000000149011612, -7.507596602685261],
  'world100_origin.eyePlanes.left': [0.8192668136424909, 0, -0.573412493815822, 0],
  'world100_origin.eyePlanes.right': [-0.8192668136424909, 0, -0.573412493815822, 0],
  'world100_origin.eyePlanes.bottom': [0, 0.9961946977612705, -0.08715574652500525, 0],
  'world100_origin.eyePlanes.top': [0, -0.9961946977612705, -0.08715574652500525, 0],
  'world100_origin.eyePlanes.near': [0, 0, -1.0, -0.010000000223502524],
  'world100_origin.eyePlanes.far': [0, 0, 1.0, 150.0745471824687],
  'world100_origin.worldPlanes.left': [0.8192668136424909, 0, -0.573412493815822, -0.1433531234539555],
  'world100_origin.worldPlanes.right': [-0.8192668136424909, 0, -0.573412493815822, -0.1433531234539555],
  'world100_origin.worldPlanes.bottom': [0, 0.9961946977612705, -0.08715574652500525, -0.12140840789182414],
  'world100_origin.worldPlanes.top': [0, -0.9961946977612705, -0.08715574652500525, 0.0778305346293215],
  'world100_origin.worldPlanes.near': [0, 0, -1.0, -0.2600000002235025],
  'world100_origin.worldPlanes.far': [0, 0, 1.0, 150.3245471824687],
  'world100_origin.eyeWorld': [0, 0.10000000149011612, -0.25],
};

/** Native boolean results. */
export const GOLDEN_BOOLS: Readonly<Record<string, readonly boolean[]>> = {
  'gcamera.use65_aspect1.perspectiveSet': [true],
  'gcamera.fixPerspective.perspectiveSet': [true],
  'frustumQ.neg200_fov20.inside': [false, false, true, false, false],
  'frustumQ.yaw350_fov140.inside': [true, false, false, true, true],
  'frustumQ.yaw90_fov180.inside': [true, false, true, true, false],
  'frustumQ.yaw45_fov360.inside': [true, true, true, true, true],
  'frustumQ.yaw0_fov0.inside': [false, true, true, true, true],
  'frustumQ.yaw180_fov140.inside': [true, true, true, true, false],
  'minitest_a10_focus_min.frustumXZ.inside': [false, false, false, false],
  'minitest_a10_focus_mid.frustumXZ.inside': [false, false, false, true],
  'minitest_a10_focus_max.frustumXZ.inside': [false, false, false, true],
  'vision_pitch_yaw.frustumXZ.inside': [false, false, false, true],
  'wrap_yaw170_fov140.frustumXZ.inside': [true, true, false, false],
  'world100_origin.frustumXZ.inside': [false, true, false, true],
};

/** The fixed scene configs behind the `gl.obj-><name>.*` vectors. */
export interface GoldenScene {
  readonly name: string;
  readonly worldSize: number;
  readonly agentFOV: number;
  readonly minFocus: number;
  readonly maxFocus: number;
  readonly eyeHeight: number;
  readonly agentHeight: number;
  readonly retinaWidth: number;
  readonly retinaHeight: number;
  /** agent::SetGeometry(): Size() * sqrt(geneCache.maxSpeed) */
  readonly fLengthZ: number;
  readonly agentX: number;
  readonly agentY: number;
  readonly agentZ: number;
  /** agent fAngle[0] in degrees */
  readonly agentYaw: number;
  /** outputNerves.focus->get(), 0..1 */
  readonly focus: number;
  readonly enablePitch: boolean;
  /** outputNerves.visionPitch->get(), 0..1 */
  readonly visionPitch: number;
  readonly enableYaw: boolean;
  /** outputNerves.visionYaw->get(), 0..1 */
  readonly visionYaw: number;
}

const sceneFlag = (v: string): boolean => v === '1';

export const GOLDEN_SCENES: readonly GoldenScene[] = [
  {
    name: 'minitest_a10_focus_min',
    worldSize: 25.0,
    agentFOV: 10.0,
    minFocus: 20.0,
    maxFocus: 140.0,
    eyeHeight: 0.5,
    agentHeight: 0.200000003,
    retinaWidth: 22,
    retinaHeight: 22,
    fLengthZ: 1.0,
    agentX: 15.3500004,
    agentY: 0.100000001,
    agentZ: -16.7199993,
    agentYaw: 45.0,
    focus: 0,
    enablePitch: sceneFlag('0'),
    visionPitch: 0.5,
    enableYaw: sceneFlag('0'),
    visionYaw: 0.5,
  },
  {
    name: 'minitest_a10_focus_mid',
    worldSize: 25.0,
    agentFOV: 10.0,
    minFocus: 20.0,
    maxFocus: 140.0,
    eyeHeight: 0.5,
    agentHeight: 0.200000003,
    retinaWidth: 22,
    retinaHeight: 22,
    fLengthZ: 1.0,
    agentX: 15.3500004,
    agentY: 0.100000001,
    agentZ: -16.7199993,
    agentYaw: 45.0,
    focus: 0.5,
    enablePitch: sceneFlag('0'),
    visionPitch: 0.5,
    enableYaw: sceneFlag('0'),
    visionYaw: 0.5,
  },
  {
    name: 'minitest_a10_focus_max',
    worldSize: 25.0,
    agentFOV: 10.0,
    minFocus: 20.0,
    maxFocus: 140.0,
    eyeHeight: 0.5,
    agentHeight: 0.200000003,
    retinaWidth: 22,
    retinaHeight: 22,
    fLengthZ: 2.44948983,
    agentX: 15.3500004,
    agentY: 0.100000001,
    agentZ: -16.7199993,
    agentYaw: 45.0,
    focus: 1.0,
    enablePitch: sceneFlag('0'),
    visionPitch: 0.5,
    enableYaw: sceneFlag('0'),
    visionYaw: 0.5,
  },
  {
    name: 'vision_pitch_yaw',
    worldSize: 25.0,
    agentFOV: 10.0,
    minFocus: 20.0,
    maxFocus: 140.0,
    eyeHeight: 0.5,
    agentHeight: 0.200000003,
    retinaWidth: 22,
    retinaHeight: 22,
    fLengthZ: 1.0,
    agentX: 15.3500004,
    agentY: 0.100000001,
    agentZ: -16.7199993,
    agentYaw: 45.0,
    focus: 0.25,
    enablePitch: sceneFlag('1'),
    visionPitch: 0.25,
    enableYaw: sceneFlag('1'),
    visionYaw: 0.75,
  },
  {
    name: 'wrap_yaw170_fov140',
    worldSize: 25.0,
    agentFOV: 10.0,
    minFocus: 20.0,
    maxFocus: 140.0,
    eyeHeight: 0.5,
    agentHeight: 0.200000003,
    retinaWidth: 22,
    retinaHeight: 22,
    fLengthZ: 1.0,
    agentX: 8.0,
    agentY: 0.100000001,
    agentZ: -8.0,
    agentYaw: 170.0,
    focus: 1.0,
    enablePitch: sceneFlag('0'),
    visionPitch: 0.5,
    enableYaw: sceneFlag('0'),
    visionYaw: 0.5,
  },
  {
    name: 'world100_origin',
    worldSize: 100.0,
    agentFOV: 10.0,
    minFocus: 20.0,
    maxFocus: 140.0,
    eyeHeight: 0.5,
    agentHeight: 0.200000003,
    retinaWidth: 22,
    retinaHeight: 22,
    fLengthZ: 0.5,
    agentX: 0,
    agentY: 0.100000001,
    agentZ: 0,
    agentYaw: 0,
    focus: 0.5,
    enablePitch: sceneFlag('0'),
    visionPitch: 0.5,
    enableYaw: sceneFlag('0'),
    visionYaw: 0.5,
  },
];

/** `glrotatef <axis> <degrees>`: the six angles x three axes of the primitive probe. */
export const GOLDEN_ROTATEF: readonly { axis: 'x' | 'y' | 'z'; degrees: number }[] = [
  { axis: 'y', degrees: 45.0 },
  { axis: 'x', degrees: 45.0 },
  { axis: 'z', degrees: 45.0 },
  { axis: 'y', degrees: 90.0 },
  { axis: 'x', degrees: 90.0 },
  { axis: 'z', degrees: 90.0 },
  { axis: 'y', degrees: -90.0 },
  { axis: 'x', degrees: -90.0 },
  { axis: 'z', degrees: -90.0 },
  { axis: 'y', degrees: 30.0 },
  { axis: 'x', degrees: 30.0 },
  { axis: 'z', degrees: 30.0 },
  { axis: 'y', degrees: 7.5 },
  { axis: 'x', degrees: 7.5 },
  { axis: 'z', degrees: 7.5 },
  { axis: 'y', degrees: 180.0 },
  { axis: 'x', degrees: 180.0 },
  { axis: 'z', degrees: 180.0 },
];

/** `glperspective <fov> <aspect> <near> <far>`. */
export const GOLDEN_PERSPECTIVES: readonly { fov: number; aspect: number; near: number; far: number }[] = [
  { fov: 10.0, aspect: 2.0, near: 0.01, far: 37.5 },
  { fov: 10.0, aspect: 3.0, near: 0.01, far: 37.5 },
  { fov: 10.0, aspect: 5.0, near: 0.01, far: 37.5 },
  { fov: 10.0, aspect: 8.0, near: 0.01, far: 37.5 },
  { fov: 10.0, aspect: 14.0, near: 0.01, far: 37.5 },
  { fov: 10.0, aspect: 1.0, near: 0.01, far: 37.5 },
  { fov: 90.0, aspect: 1.0, near: 1e-05, far: 10000.0 },
];

/** `gltranslate <x> <y> <z>`. */
export const GOLDEN_TRANSLATE: readonly { x: number; y: number; z: number }[] = [
  { x: 1.5, y: -2.25, z: 0.125 },
];

/** `objpose <name> x y z yaw pitch roll scale setRotation` (gobject::position + glScalef). */
export interface GoldenObjectPose {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  readonly scale: number;
  /** false: the object never had SetRotation called, so gobject::rotate() is a no-op */
  readonly setRotation: boolean;
}

export const GOLDEN_OBJECT_POSES: readonly GoldenObjectPose[] = [
  {
    name: 'obj.yaw45',
    x: 1.0, y: 0.5, z: -2.0,
    yaw: 45.0, pitch: 0, roll: 0,
    scale: 1.0, setRotation: true,
  },
  {
    name: 'obj.yaw30_pitch-15_roll10',
    x: -3.25, y: 0, z: 7.5,
    yaw: 30.0, pitch: -15.0, roll: 10.0,
    scale: 2.0, setRotation: true,
  },
  {
    name: 'obj.unrotated',
    x: 5.0, y: 2.0, z: 0,
    yaw: 0, pitch: 0, roll: 0,
    scale: 0.5, setRotation: false,
  },
  {
    name: 'obj.rotated_zero_angles',
    x: 5.0, y: 2.0, z: 0,
    yaw: 0, pitch: 0, roll: 0,
    scale: 0.5, setRotation: true,
  },
];

/** `camuse <name> fov aspect near far x y z` (gcamera::Use, no follow object). */
export interface GoldenCameraUse {
  readonly name: string;
  readonly fov: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const GOLDEN_CAMERA_USES: readonly GoldenCameraUse[] = [
  { name: 'gcamera.use65_aspect1', fov: 65.0, aspect: 1.0, near: 0.25, far: 64.0, x: 3.0, y: 4.0, z: 5.0 },
];

/** `camfix <name> fov near far width height x y z` (FixPerspective + Use). */
export interface GoldenCameraFix {
  readonly name: string;
  readonly fov: number;
  readonly near: number;
  readonly far: number;
  /** SetAspect(width, height) */
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const GOLDEN_CAMERA_FIXES: readonly GoldenCameraFix[] = [
  { name: 'gcamera.fixPerspective', fov: 60.0, near: 0.5, far: 16.0, width: 640.0, height: 480.0, x: -1.0, y: 0, z: 2.0 },
];

/** `fqcase <name> x z ang fov`: frustumXZ::Set(x, z, ang, fov). */
export const GOLDEN_FRUSTUM_CASES: readonly { name: string; x: number; z: number; ang: number; fov: number }[] = [
  { name: 'frustumQ.neg200_fov20', x: 0, z: 0, ang: -200.0, fov: 20.0 },
  { name: 'frustumQ.yaw350_fov140', x: 0, z: 0, ang: 350.0, fov: 140.0 },
  { name: 'frustumQ.yaw90_fov180', x: 0, z: 0, ang: 90.0, fov: 180.0 },
  { name: 'frustumQ.yaw45_fov360', x: 0, z: 0, ang: 45.0, fov: 360.0 },
  { name: 'frustumQ.yaw0_fov0', x: 0, z: 0, ang: 0, fov: 0 },
  { name: 'frustumQ.yaw180_fov140', x: 3.0, z: -4.0, ang: 180.0, fov: 140.0 },
];

/** `fqrad <name> x z ang fov rad`: frustumXZ::Set(x, z, ang, fov, rad). */
export const GOLDEN_FRUSTUM_RADII: readonly { name: string; x: number; z: number; ang: number; fov: number; rad: number }[] = [
  { name: 'frustumQ.rad0.5', x: 4.0, z: -6.0, ang: 30.0, fov: 80.0, rad: 0.5 },
  { name: 'frustumQ.rad1', x: 4.0, z: -6.0, ang: 30.0, fov: 80.0, rad: 1.0 },
  { name: 'frustumQ.rad2.5', x: 4.0, z: -6.0, ang: 30.0, fov: 80.0, rad: 2.5 },
];

/** `geom polyobj nPolys=.. points=.. v=..|..`: the gpolyobj fixture polygons. */
export const GOLDEN_POLYOBJ: { readonly polygons: readonly (readonly number[])[] } = {
  polygons: [
    [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5],
    [-0.25, -0.5, 1.5, 0.75, -0.5, 1.5, 0.75, 0.25, 1.5, -0.25, 0.25, 1.5],
  ],
};

/** The inside/outside fan of the frustum cases, in `fqcase` order. */
export const GOLDEN_FRUSTUM_INSIDE: Readonly<Record<string, readonly boolean[]>> = {
  'frustumQ.neg200_fov20': [false, false, true, false, false],
  'frustumQ.yaw350_fov140': [true, false, false, true, true],
  'frustumQ.yaw90_fov180': [true, false, true, true, false],
  'frustumQ.yaw45_fov360': [true, true, true, true, true],
  'frustumQ.yaw0_fov0': [false, true, true, true, true],
  'frustumQ.yaw180_fov140': [true, true, true, true, false],
  'minitest_a10_focus_min.frustumXZ': [false, false, false, false],
  'minitest_a10_focus_mid.frustumXZ': [false, false, false, true],
  'minitest_a10_focus_max.frustumXZ': [false, false, false, true],
  'vision_pitch_yaw.frustumXZ': [false, false, false, true],
  'wrap_yaw170_fov140.frustumXZ': [true, true, false, false],
  'world100_origin.frustumXZ': [false, true, false, true],
};
