let _storeHash = {};
let tools = {}

function log(...msg) {
  console.log(msg)
}

tools.anime = class{
  constructor(target){
    this.target = target
  }
}

tools.anime_blink = function (target, frame, timeout, cb_begin, cb_end) {
  cb_end && cb_end()
  let count = true;
  let interval = setInterval(() => {
    if (document.body.contains(target)) {
      if (count) {
        cb_begin && cb_begin(target)
        count = false
      } else {
        cb_end && cb_end(target)
        count = true
      }
    } else {
      clearInterval(interval)
    }
  }, frame)

  if (timeout > 0) {
    setTimeout(() => {
      clearInterval(interval)
    }, timeout)
  }
  return () => {
    clearInterval(interval)
  }
}

tools.target_move_event = function(ev, target){
  if (ev.button === 0) {
    ev.preventDefault();
    let x = ev.clientX;
    let y = ev.clientY;
    let oL = target.offsetLeft;
    let oT = target.offsetTop;
    document.onmousemove = function (e) {
      let xx = e.clientX;
      let yy = e.clientY;
      target.style.left = xx - x + oL + "px"
      target.style.top = yy - y + oT + "px"
    }
    document.onmouseup = function () {
      document.onmousemove = null;
      document.onmouseup = null;
    }
  }
}

tools.target_resize_event = function(ev, target){
  if (ev.button === 2) {
    let x = ev.clientX;
    let y = ev.clientY;
    let oL = target.offsetLeft;
    let oT = target.offsetTop;
    if(x < oL + (target.offsetWidth / 2)){
      // 保留左边一半 右键正常使用
      return 
    }
    target.style.cursor = "se-resize"
    document.oncontextmenu = () => false
    document.onmousemove = function (e) {
      let xx = e.clientX;
      let yy = e.clientY;
      target.style.width = xx - oL + 30 + "px"
      target.style.height = yy - oT + 30 + "px"
    }
    document.onmouseup = function (e) {
      setTimeout(function () {
        document.oncontextmenu = () => true
      }, 1000)
      target.style.cursor = "text"
      document.onmousemove = null;
      document.onmouseup = null;
    }
  }
}


tools.target_drag_event = function(cbk, target){
  // 阻止默认处理以允许放置
  // 元素事件有三个 dragstart drag dragend
  // 容器事件
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    target.addEventListener(eventName, preventDefaults, false);
  });

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // 处理文件放置事件
  target.addEventListener('drop', (ev)=>{
    let files = ev.dataTransfer.files; // 获取文件列表
    cbk && cbk(files)
  }, false);
}


tools.dialog = class{
  constructor(cfg={},cbk){
    cfg = Object.assign({
      title: 'Dialog',
      // {title: '测试',tips: '提示',hotkey: 'Enter',onclick: (self, ev)=>{},style: 'color: white'}
      menus: [],
      hotkeys: [{ hotkey : 'x', onclick : (self, ev) => { self.close() } }]
    }, cfg)
    //
    this.wrq外容器 = document.createElement('div');
    this.cdl菜单栏 = document.createElement('div');
    this.nrq内容器 = document.createElement('div');
    this.gb关闭 = document.createElement("span");
    this.bt标题 = document.createElement("span"); 
    this.cdl菜单栏.appendChild(this.bt标题)
    this.cdl菜单栏.appendChild(this.gb关闭)
    this.wrq外容器.appendChild(this.cdl菜单栏)
    this.wrq外容器.appendChild(this.nrq内容器)
    //默认样式
    this.wrq外容器.tabIndex = 0
    this.wrq外容器.className = 'dialog'
    this.wrq外容器.style = 'border: 2px solid black; position: fixed; width: 60%; height: 60%; left: 20%; bottom: 20%; box-sizing: border-box; background: white'
    //
    this.cdl菜单栏.style = 'box-sizing: border-box; background: black; width: 100%; height: 30px; cursor: move'
    //
    this.bt标题.title = document.getElementsByClassName('dialog').length + 1
    this.bt标题.innerHTML = cfg.title; 
    this.bt标题.style = 'color: white; marginLeft: 3px; max-width: 50%'
    //
    this.gb关闭.innerHTML = '[X]'
    this.gb关闭.title = '关闭'
    this.gb关闭.style = 'color: white; position: absolute; cursor: pointer; right: 3px'
    //
    this.nrq内容器.style = 'box-sizing: border-box; width: 100%; height: calc(100% - 30px); background: white'
    document.body.appendChild(this.wrq外容器)
    //默认事件
    let self = this;
    this.cdl菜单栏.onmousedown = (ev) => {
      tools.target_move_event(ev, self.wrq外容器)
    }
    this.nrq内容器.onmousedown = (ev) => {
      tools.target_resize_event(ev, self.wrq外容器)
    }
    this.gb关闭.onclick = (ev) => {
      self.onclose && self.onclose(self,ev)
      cfg.onclose && cfg.onclose(self,ev)
      self.wrq外容器.remove()
    }
    // 调整为 map 避免键重复
    this.hotKeys = cfg.hotkeys.reduce((a,c)=>{ 
      a[c.hotkey] = c.onclick
      return a
    },new Map())
    // 快捷键事件
    this.wrq外容器.addEventListener("keydown", function (ev) {
      //console.log(' >> dialog key up', ev, Object.keys(self.hotKeys))
      if (ev.ctrlKey) {
        if (self.hotKeys[ev.key]) {
          // 取消默认事件
          ev.preventDefault();
          self.hotKeys[ev.key](self, ev)
        }
      }
    });
    // 初始 参数中的按钮和快捷键
    cfg.menus.forEach(menu => self.add_menu(menu))
    // 默认聚焦
    this.wrq外容器.focus()
    cbk && cbk(this)
  }

  close(){
    this.gb关闭.click()
  }

  add_element(target){
    this.nrq内容器.appendChild(target)
  }
  add_menu(cfg={}){
    let self = this;
    let menu = document.createElement('span')
    let index = self.cdl菜单栏.childNodes.length - 1;
    cfg = Object.assign({
      title: `按钮${index}`,
      tips: `这是按钮${index}`,
      onclick: (self, ev)=>{
        console.log(`> ${cfg.title} ${index} is clicked`)
      },
      hotkey: `${index}`,
      style: 'color: white; cursor: pointer; marginLeft: 5px'
    }, cfg)

    menu.style = cfg.style
    menu.innerHTML = cfg.title
    menu.title = cfg.tips
    menu.style.marginLeft = "5px"
    if (index === 1) {
      menu.style.marginLeft = "25px"
    }
    menu.onclick = (ev) => {
      cfg.onclick && cfg.onclick(self, ev)
    }
    self.hotKeys[cfg.hotkey] = cfg.onclick
    self.cdl菜单栏.appendChild(menu);
    return menu;
  }

  static open(cfg, cbk){
    return new this(cfg, cbk)
  }
}

tools.dialog_tips = class extends tools.dialog{
  constructor(cfg={},cbk){ 
    cfg = Object.assign({timeout: 2000, title: 'Tips', content: '...'}, cfg)
    super()
    let self = this;
    let random_pos =  Math.floor(Math.random() * 100) + 50;
    this.wrq外容器.style.width = '30%'
    this.wrq外容器.style.height = '30%'
    this.wrq外容器.style.top = `calc(5% + ${random_pos}px)`
    this.wrq外容器.style.left = `calc(30% + ${random_pos}px)`

    this.nrq内容器.readOnly = true
    this.nrq内容器.style.resize = "none"
    this.nrq内容器.style.overflow = "hidden"
    this.nrq内容器.style.display= 'flex'
    this.nrq内容器.style.justifyContent = 'center'
    this.nrq内容器.style.alignItems = 'center'
    this.bt标题.innerHTML = cfg.title  +  (this.bt标题.title > 1 ? ` (${this.bt标题.title})` : '') ; 
    this.nrq内容器.innerHTML = cfg.content

    setTimeout(() => {
      if (cfg.timeout > 0) {
        self.close()
        cbk && cbk()
      }
    }, cfg.timeout)
  }
}

tools.dialog_input = class extends tools.dialog{
  constructor(cfg={}, cbk){ 
    cfg = Object.assign({title: 'Input', inputs: [{name: '输入一',tips: '在这里输入'}]}, cfg)
    super({menus: [{title: '提交', hotkey: 'Enter',onclick: (self, ev)=>{
      if(cfg.onok){
        if(cfg.onok(this.inputs.map(v=>v.value))){
          self.close()
        }
        return
      }
      self.close()
    }}]})
    let self = this;
    this.wrq外容器.style.width = '20%'
    this.wrq外容器.style.height = '30px'
    this.wrq外容器.style.top = '40%'
    this.wrq外容器.style.left = '40%'
    this.bt标题.innerHTML = cfg.title;
    this.inputs = []

    this.nrq内容器.style.overflow = 'hidden'
    cfg.inputs.forEach((v,i)=>{
      let div = document.createElement('div');
      div.style = 'width: 100%; height: 30px; box-sizing: border-box; display: flex; justify-content: space-between;'
      let span = document.createElement('span');
      span.style = 'width: 30%; height: 100%'
      span.innerHTML = v.name;


      let text = document.createElement('input')
      text.value = v.default
      text.type = v.type 
      text.style = 'width: 70%; height: 100%; box-sizing: border-box;'
      text.onchange=(ev)=>{
        v.onchange && v.onchange(ev, self)
      }
      div.appendChild(span)
      div.appendChild(text)
      self.inputs.push(text)
      this.wrq外容器.style.height = `${30*(i+2)}px`
      this.nrq内容器.appendChild(div)
    })
    cbk && cbk(self)
  }
}


tools.dialog_progress = class extends tools.dialog {
  constructor(cfg={}, ckb){
    cfg = Object.assign({
      title: '进度条'
    }, cfg)
    super(cfg)
    //样式
    this.wrq外容器.style.width = '320px'
    this.wrq外容器.style.height = '120px'
    // 样式一 >>>>>
    this.jdt容器 = document.createElement('div')
    this.jdt容器.style.display = 'grid'
    this.jdt容器.style.placeItems = 'center'
    this.jdt容器.style.backgroundColor = 'green'
    this.jdt容器.style.width = '0%'
    this.jdt容器.style.height = '100%'
    this.jdt容器.innerText = '0%'
    this.nrq内容器.appendChild(this.jdt容器)

    this.title = cfg.title
  }

  fail(){
    this.interval_func = tools.anime_blink(this.jdt容器, 500, 0, ()=>{
      this.jdt容器.style.background = 'red'
    }, ()=>{
      this.jdt容器.style.background = 'white'
    })
  }

  success(){
    tools.dialog_tips.open({timeout: 3000 ,content: '进度完成'},()=>{
      this.close()
    })
  }

  update(progress){
    this.jdt容器.style.width = progress + '%'
    this.jdt容器.innerText = progress + '%'
    this.bt标题.innerHTML = `${this.title} (${progress}%)` 
    this.interval_func && this.interval_func()
  }
}

tools.upload_file = class{
  constructor(cfg={}){
    cfg = Object.assign({
      chunkSize: 512,
      progress :{},
    }, cfg)
    this.file =cfg.file;
    this.url = cfg.url
    this.uuid = cfg.uuid
    this.fileName = this.file.name
    this.chunkSize = cfg.chunkSize
    this.chunkCount = Math.ceil(this.file.size / this.chunkSize)
    this.fileHash = ''
    this.chunkIndex = 0
    this.uploadSize = 0
    this.progress_class = cfg.progress
    this.progress_default = tools.dialog_progress.open()
  }

  async  read_chunk_bytes(index, chunkSize){
    //this.event_progess(index, chunkSize, this.file.size)
    let do_chunk = (index, chunkSize, file)=>{
      return new Promise((resolve)=>{
        let chunk = file.slice(index*chunkSize,(index + 1) * chunkSize);
        let reader = new FileReader();
        reader.readAsArrayBuffer(chunk);
        reader.onload = (data)=>{
          let bytes = data.target.result
          resolve(bytes)
        }
      })
    };
    return await do_chunk(index, chunkSize, this.file);
  }

  async get_upload_status(){
    let self = this;
    let resp = await fetch(this.url,{
      method: 'POST',
      body: JSON.stringify({
        uuid: self.uuid,
        fileName: self.file.name,
        fileSize: self.file.size,
        fileType: self.file.type,
        chunkSize: self.chunkSize,
        uploadSize: 0,
        chunkCount: self.chunkCount,
        chunkIndex: 0
      })
    })
    let info = await resp.json()
    this.chunkSize = info.chunkSize;
    this.chunkCount = info.chunkCount
    this.chunkIndex = info.chunkIndex
    this.uploadSize = info.uploadSize
    console.log('>>>> 远端文件状态',info)
    return info
  }

  by_websocket(){
    let self = this;
    this.get_upload_status()
    let ws = new WebSocket(self.url);

    ws.onopen = async ()=>{
      console.log('上传连接成功')
      let bytes = await self.read_chunk_bytes(self.chunkIndex,self.chunkSize);
      self.progress_class.start && self.progress_class.start()
      ws.send(bytes)
    }
    ws.onmessage = async (v)=>{
      let pg = JSON.parse(v.data)
      self.chunkIndex = pg[0]
      self.uploadSize = pg[1]
      self.progress_class.chunkStart && self.progress_class.chunkStart(self.chunkIndex)
      let bytes = await self.read_chunk_bytes(self.chunkIndex,self.chunkSize);
      self.progress_class.chunkEnd && self.progress_class.chunkEnd(self.chunkIndex)
      ws.send(bytes)
      self.progress_class.update && self.progress_class.update(Math.round((self.chunkIndex / self.chunkCount) * 100))
      if(self.chunkIndex >= self.chunkCount){
        self.progress_class.end && self.progress_class.end()
        tools.dialog_tips.open({content: '上传完毕', timeout: 3000})
        console.log('>>>> upload finish reay close')
        ws.close()
      }
    }
    ws.onclose = ()=>{
      self.progress_class.success && self.progress_class.success()
    }
    ws.onerror = ()=>{
      self.progress_class.fail && self.progress_class.fail()
    }
    return this
  }


  progress(target){
    if(target){
      this.progress_class = target
    }else{
      this.progress_class = this.progress_default
    }
    //update finish error
    return this
  }
}




tools.req_url_encode = function (url, params = {}) {
  return fetch(url, {
    method: (params['method'] || "POST"),
    body: params['method'] === 'GET' ? undefined : Object.entries(Object.assign({
      "_uuid_": new Date().getTime(),
    }, params['body'])).reduce((a, c) => {
      a.push(encodeURIComponent(c[0]) + '=' + encodeURIComponent(c[1]))
      return a
    }, []).join('&'),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  })
}


tools.req = function (url, ext) {
  return fetch(url, Object.assign({
    method: 'GET',
    headers: {
      'Content-Type': 'application/json'
    }
  }, ext)
  ).then(resp => {
    return resp.text()
  })
}

tools.req_post = function (url, body = {}) {
  return tools.req(url, {
    method: "POST",
    body: JSON.stringify(Object.assign({
      "_uuid_": new Date().getTime(),
    }, body)),
    headers: {
      'Content-Type': 'application/json'
    }
  })
}

tools.req_get = function (url) {
  return tools.req(url, {
    method: "GET",
    headers: {
      'Content-Type': 'application/json'
    }
  })
}

tools.upload_file_post = function (file, url) {
  return tools.req(url, {
    method: 'POST',
    body: file,
    headers: {
      'Upload-File-Name': file.name
    },
    onprogress: (event) => {
      const progressPercentage = Math.round((event.loaded / event.total) * 100);
      console.log(`上传进度: ${progressPercentage}%`);
    }
  })
}
tools.upload_file_post_progress = function (file, url, cb) {
  return new Promise((resolve, reject) => {
    if (cb === undefined) {
      // 默认行为
      cb = tools.dialog_progress.open({
        title: '上传进度 (' + file.name + ')'
      })
    }
    let xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    // 设置请求的头部
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Upload-File-Name', file.name);
    // 监听上传进度事件
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        let progressPercentage = Math.round((event.loaded / event.total) * 100);
        if (cb.update) {
          cb.update(progressPercentage.toFixed(2))
        } else {
          cb(progressPercentage.toFixed(2))
        }
        if (progressPercentage === 100) {
          if (cb.waiting) {
            cb.waiting(' 服务器接收中... ')
          }
        }
        //console.log(`Upload progress: ${progressPercentage.toFixed(2)}%`);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        (cb && cb['done'] && cb.done())
        resolve(xhr.response);
      } else {
        console.error(xhr)
        (cb && cb['error'] && cb.error('服务器响应失败'))
        reject(new Error('Failed to upload file'));
      }
    };
    xhr.onerror = () => {
      console.error(xhr)
      (cb && cb['error'] && cb.error('服务器网路链接失败'))
      reject(new Error('Network error'))
    };
    xhr.send(file);
  })
}

tools.upload_file_formData = function (file, url) {
  //formData
  let formData = new FormData();
  formData.append('file', file)
  return tools.req(url, {
    method: 'POST',
    body: formData
  })
}

//需要服务器端实现
// 断点续传 实时进度 分片传输
// /file/upload/file/uuid
tools.upload_file_websocket = function (url, chunk, uuid, file) {
  //请求数据 是否续传
  let chunks = Math.ceil(file.size / chunk);
  //fetch(url,{
  //  method: 'POST',
  //  body: JSON.stringify({
  //    uuid: uuid,
  //    fileName: file.name,
  //    fileSize: file.size,
  //    fileType: file.type,
  //    chunkSize: chunk,
  //    uploadedSize: 0,
  //    totleChunkIndex: chunks,
  //    chunkIndex: 0
  //  })
  //}).then(r=>r.json()).then(r=>{
  let send_chunk = (index, chunkSize, file, cbk)=>{
    return new Promise((resolve)=>{
      let chunk = file.slice(index*chunkSize,(index + 1) * chunkSize);
      let reader = new FileReader();
      reader.readAsArrayBuffer(chunk);
      reader.onload = (data)=>{
        let bytes = data.target.result
        resolve(bytes)
        cbk && cbk(bytes)
      }
    })
  }
  let ws = new WebSocket(url);
  ws.onopen = async ()=>{
    //开始上传
    ws.send(JSON.stringify({
      uuid: uuid,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      chunkSize: chunk,
      uploadedSize: 0,
      chunkCount: chunks,
      chunkIndex: 0
    }))

  }
  ws.onmessage = async (m)=>{
    //获取进度
    let info = JSON.parse(m.data)
    if(info.uploadedSize < file.size){
      let bytes = await send_chunk(info.chunkIndex,info.chunkSize,file);
      ws.send(bytes)
    }else{
      tools.dialog_tips.open({content: '上传完毕', timeout: 3000})
      console.log('>>>>>>>> upload done',info)
      ws.close()
    }
  }
  ws.onclose = ()=>{

  }
  ws.onerror = (e)=>{
    console.error('>>> websocket uplaod error websocket err',e)
  }
  //}).catch( e =>{
  //  console.error('>>> websocket uplaod error post info',e)
  //})
  //上传
}


function _get_added(k, cb) {
  if (_storeHash['_get_addeds']) {
    if (_storeHash['_get_addeds'][k]) {
      _storeHash['_get_addeds'][k].v = _storeHash['_get_addeds'][k].f(
        _storeHash['_get_addeds'][k].v
      );
      cb && cb(_storeHash['_get_addeds'][k])
    } else {
      //init
      _storeHash['_get_addeds'][k] = {
        v: cb && cb(null) || 0,
        f: cb || function (v) {
          return v + 1
        }
      };
    }
    return _storeHash['_get_addeds'][k].v;
  } else {
    _storeHash['_get_addeds'] = {};
    return _get_added(k, cb);
  }

}

//function set(id, cb) {
//    let tdm = document.createElement("div");
//    tdm.id = id;
//    cb && cb(tdm)
//}

function get_local_video(id) {
  let video = document.createElement("video");
  video.id = id;
  video.width = 320;
  video.height = 240;
  //add Event
  video.float = 'right';
  video.style.position = 'absolute';
  video.style.right = '10px';
  video.style.top = '10px';
  video.style.zIndex = '999';
  video.style.border = 'thick solid #0000FF';
  video.take_photo = function () {
  }
  video.onmousedown = function (ev_d) {
    video.onmousemove = function (ev_m) {
      video.style.left = (ev_m.clientX - ev_d.layerX) + 'px';
      video.style.top = (ev_m.clientY - ev_d.layerY) + 'px';
    };
    video.onmouseup = function () {
      video.onmousemove = null;
      video.onmouseup = null;
    }
  };
  window.navigator.getUserMedia = MediaDevices.getUserMedia || navigator.getUserMedia || navigator.webKitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
  let peerConnection = new RTCPeerConnection(null);
  if (window.navigator.getUserMedia) {
    window.navigator.getUserMedia({
      //video: {facingMode: {exact: "environment"}}
      video: {'facingMode': "user"}
    }, onSuccess, function (e) {
      alert("Try To Share Screen");
      window.navigator.getUserMedia({
        //video: {facingMode: {exact: "environment"}}
        video: {'mediaSource': "screen"}
      }, onSuccess, function (ee) {
        alert(ee)
      });
    });
  } else {
    alert('your browser not support getUserMedia;');
  }

  function onSuccess(stream) {
    //if (navigator.mozGetUserMedia) {
    video.srcObject = stream;
    //} else {
    //    let vendorURL = window.URL || window.webkitURL;
    //    video.src = vendorURL.createObjectURL(stream);
    //}
    video.onloadedmetadata = function (e) {
      video.play();
    };
    peerConnection.addStream(stream);
  }

  return video;
}


function webRtc() {
  window.RTCPeerConnection = window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
  let peerConnection = new RTCPeerConnection(null);

  window.navigator.getUserMedia = MediaDevices.getUserMedia || navigator.getUserMedia || navigator.webKitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
  if (window.navigator.getUserMedia) {
    window.navigator.getUserMedia({
      //video: {facingMode: {exact: "environment"}}
      video: {'facingMode': "user"}
    }, onSuccess, function (e) {
      alert("Try To Share Screen");
      window.navigator.getUserMedia({
        //video: {facingMode: {exact: "environment"}}
        video: {'mediaSource': "screen"}
      }, onSuccess, function (ee) {
        alert(ee)
      });
    });
  } else {
    alert('your browser not support getUserMedia;');
  }

  function onSuccess(stream) {
    peerConnection.addStream(stream);
    //
    peerConnection.createOffer(function (desc) {
      console.log("创建offer成功");
      // 将创建好的offer设置为本地offer
      peerConnection.setLocalDescription(desc);
      // 通过socket发送offer
    }, function (error) {
      // 创建offer失败
      console.log("创建offer失败");
    })
  }
}

function copyToclip(txt) {
  if (document.execCommand("copy")) {
    const input = document.createElement("input"); // 创建一个新input标签
    input.setAttribute("readonly", "readonly"); // 设置input标签只读属性
    input.setAttribute("value", txt); // 设置input value值为需要复制的内容
    document.body.appendChild(input); // 添加input标签到页面
    input.select(); // 选中input内容
    input.setSelectionRange(0, 9999); // 设置选中input内容范围
    document.execCommand("copy"); // 复制
    document.body.removeChild(input);  // 删除新创建的input标签
  }
}


function preventAll(ev) {
  ev.preventDefault()
  ev.stopPropagation()
}
