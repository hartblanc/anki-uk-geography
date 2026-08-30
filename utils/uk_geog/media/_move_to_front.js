var moveToFront = function(id) {
  var el = document.getElementById(id);
    if (el) {
      el.parentElement.appendChild(el);
    }
};
