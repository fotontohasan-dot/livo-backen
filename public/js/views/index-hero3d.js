(function() {
  const container = document.getElementById('hero-3d');
  if (!container) return;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / 400, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, 400);
  container.appendChild(renderer.domElement);

  const geometry = new THREE.BufferGeometry();
  const count = 600;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) positions[i] = (Math.random() - 0.5) * 20;
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ size: 0.05, color: 0x00ffaa, transparent: true, opacity: 0.8 });
  const points = new THREE.Points(geometry, material);
  scene.add(points);
  camera.position.z = 8;

  function animate() {
    requestAnimationFrame(animate);
    points.rotation.y += 0.001;
    points.rotation.x += 0.0005;
    renderer.render(scene, camera);
  }
  animate();
})();
