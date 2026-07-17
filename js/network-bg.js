(function () {
  var canvas = document.getElementById('network-bg');
  var ctx = canvas.getContext('2d');

  var width, height, dpr;
  var nodes = [];
  var NODE_COUNT = 70;
  var LINK_DIST = 130;
  var MAX_NODE_COUNT = 140;

  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var target = Math.round((width * height) / 16000);
    NODE_COUNT = Math.max(30, Math.min(MAX_NODE_COUNT, target));
    initNodes();
  }

  function initNodes() {
    nodes = [];
    for (var i = 0; i < NODE_COUNT; i++) {
      nodes.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3
      });
    }
  }

  function step() {
    ctx.clearRect(0, 0, width, height);

    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      n.x += n.vx;
      n.y += n.vy;

      if (n.x < 0 || n.x > width) n.vx *= -1;
      if (n.y < 0 || n.y > height) n.vy *= -1;
    }

    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        var a = nodes[i], b = nodes[j];
        var dx = a.x - b.x, dy = a.y - b.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < LINK_DIST) {
          var alpha = (1 - dist / LINK_DIST) * 0.35;
          ctx.strokeStyle = 'rgba(79, 209, 197, ' + alpha + ')';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      ctx.fillStyle = 'rgba(232, 234, 240, 0.55)';
      ctx.beginPath();
      ctx.arc(n.x, n.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    if (!prefersReducedMotion) {
      requestAnimationFrame(step);
    }
  }

  window.addEventListener('resize', resize);
  resize();

  if (prefersReducedMotion) {
    step();
  } else {
    requestAnimationFrame(step);
  }
})();
