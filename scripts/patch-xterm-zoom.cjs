// Reapply the local xterm 5.3.0 mouse-coordinate fix after restoring upstream.
// Run: node scripts/patch-xterm-zoom.cjs
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../public/static/vendor/xterm/xterm.min.js');
const original = 'function i(e,t,i){const s=i.getBoundingClientRect(),r=e.getComputedStyle(i),n=parseInt(r.getPropertyValue("padding-left")),o=parseInt(r.getPropertyValue("padding-top"));return[t.clientX-s.left-n,t.clientY-s.top-o]}';
const replacement = `function i(window, event, element) {
    /* WebSSH: normalize CSS zoom for selection, links, mouse reports and drag scrolling. */
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const scaleX = (element.offsetWidth && rect.width / element.offsetWidth) || 1;
    const scaleY = (element.offsetHeight && rect.height / element.offsetHeight) || 1;
    return [
        (event.clientX - rect.left) / scaleX - (parseFloat(style.paddingLeft) || 0),
        (event.clientY - rect.top) / scaleY - (parseFloat(style.paddingTop) || 0)
    ];
}`;
const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
if (!source.includes(replacement)) {
    if (source.split(original).length !== 2) throw new Error('Expected the original xterm 5.3.0 coordinate helper exactly once');
    fs.writeFileSync(file, source.replace(original, replacement));
} else {
    fs.writeFileSync(file, source);
}
