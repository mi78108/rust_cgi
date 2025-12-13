let tools = {
  log: (...m) => {
    console.log(...m)
  },
  gen_random_text:  (cfg = {
    number: true,
    char: true,
    length: 4
  })=>{
    let dict = cfg.number ? '1234567890' : '' ;
    dict += cfg.char ? 'abcdefghijklmnopqrst' : '';
    dict = dict.split('');

    return Array.from({ length: cfg.length}).map(_=>{
      return dict[Math.round(Math.random() * dict.length)]
    }).join('')
  },
  target_move_event : function (ev, target) {
    if (ev.button === 0) {
      ev.preventDefault();
      let x = ev.clientX;
      let y = ev.clientY;
      let oL = target.offsetLeft;
      let oT = target.offsetTop;
      document.onmousemove = (e) => {
        let xx = e.clientX;
        let yy = e.clientY;
        target.style.left = xx - x + oL + "px"
        target.style.top = yy - y + oT + "px"
      }
      document.onmouseup =  () => {
        document.onmousemove = null;
        document.onmouseup = null;
      }
    }
  },
  target_drag_event : function (target, cbk) {
    // 阻止默认处理以允许放置
    // 元素事件有三个 dragstart drag dragend
    let oldStyle = target.style.backgroundColor
    target.addEventListener('dragenter',(ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = 'copy';
      target.style.backgroundColor = 'gray'
    })
    target.addEventListener('dragover',(ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
    })
    target.addEventListener('dragleave',(ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      target.style.backgroundColor = oldStyle
    })
    // 处理文件放置事件
    target.addEventListener('drop', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      let files = ev.dataTransfer.files; // 获取文件列表
      cbk && cbk(files)
      target.style.backgroundColor = oldStyle
    }, false);
  },
  target_resize_event : function (ev, target) {
    if (ev.button === 2) {
      let x = ev.clientX;
      let y = ev.clientY;
      let oL = target.offsetLeft;
      let oT = target.offsetTop;
      if (x < oL + (target.offsetWidth / 2)) {
        // 保留左边一半 右键正常使用
        return
      }
      target.style.cursor = "se-resize"
      document.oncontextmenu = () => false
      document.onmousemove = function (e) {
        let xx = e.clientX;
        let yy = e.clientY;
        // target.style.width = xx - oL + 30 + "px"
        // target.style.height = yy - oT + 30 + "px"
        target.style.width = xx - oL + 5 + "px"
        target.style.height = yy - oT + 5 + "px"
      }
      document.onmouseup = function () {
        setTimeout(function () {
          document.oncontextmenu = () => true
        }, 1000)
        target.style.cursor = "text"
        document.onmousemove = null;
        document.onmouseup = null;
      }
    }
  },
  target_stillBottom_event : function (target) {
    let scrollHeight = target.scrollHeight || 1;
    // let domHeight = target.offsetHeight;
    // let domScrollTop = target.scrollTop;
    // //console.log(domScrollTop, domHeight,scrollHeight)
    // if (domScrollTop + domHeight + 100 > scrollHeight) {
      //console.log(this)
      target.scrollTop = scrollHeight;
      //}
  }
}

tools.dialog = class {
  // 参数 title=String; menus=Array; hotkeys=[{hotkey: '', onclick: func}]
  constructor(cfg = {}) {
    this.cfg = Object.assign({
      title: 'Dialog',
      // {title: '测试',tips: '提示',hotkey: 'Enter',onclick: (self, ev)=>{},style: 'color: white'}
      menus: [],
      hotkeys: [{
        hotkey: 'x', onclick: (self, ev) => {
          self.close(ev)
        }
      }]
    }, cfg);
    //
      this.wrq外容器 = document.createElement('div');
    this.cdl菜单栏 = document.createElement('div');
    this.nrq内容器 = document.createElement('div');
    this.nrqrq内容器容器 = document.createElement('div');
    this.gb关闭 = document.createElement("span");
    this.bt标题 = document.createElement("span");
    this.cdl菜单栏.appendChild(this.bt标题)
    this.cdl菜单栏.appendChild(this.gb关闭)
    this.wrq外容器.appendChild(this.cdl菜单栏)
    this.nrqrq内容器容器.appendChild(this.nrq内容器)
    this.wrq外容器.appendChild(this.nrqrq内容器容器)
    //默认样式
    //
      this.wrq外容器.tabIndex = 0
    this.wrq外容器.className = 'dialog'
    this.wrq外容器.style = 'z-index:99; border: 2px solid black; position: fixed; width: 60%; height: 60%; left: 20%; bottom: 20%; box-sizing: border-box; background: white'
    //
      this.cdl菜单栏.style = 'box-sizing: border-box; background: black; width: 100%; height: 30px; cursor: move; overflow-x: hidden'
    //
      this.bt标题.title = document.getElementsByClassName('dialog').length + 1
    this.bt标题.innerHTML = this.cfg.title;
    this.bt标题.style = 'color: white; marginLeft: 3px; height: 100%; line-height: 90%; max-width: 60%; display: inline-block; white-space: nowrap; overflow-x: hidden'
    //
      this.gb关闭.innerHTML = '[X]'
    this.gb关闭.title = '关闭'
    this.gb关闭.style = 'color: white; float: right; cursor: pointer; line-height: 90%';
    //
      this.nrq内容器.style = 'box-sizing: border-box; width: calc(100%); height: calc(100%); background: white'
    this.nrqrq内容器容器.style = 'box-sizing: border-box; width: 100%; height: calc(100% - 30px); background: black'

    document.body.appendChild(this.wrq外容器)
    //默认事件
    this.cdl菜单栏.onmousedown = (ev) => {
      tools.target_move_event(ev, this.wrq外容器)
    }
    this.nrqrq内容器容器.onmousedown = (ev) => {
      tools.target_resize_event(ev, this.wrq外容器)
    }
    this.gb关闭.onclick = (ev) => {
      this.close(ev)
    }
    // 调整为 map 避免键重复
    this.hotKeys = this.cfg.hotkeys.reduce((a, c) => {
      a[c.hotkey] = c.onclick
      return a
    }, new Map())
    // 快捷键事件
    this.wrq外容器.addEventListener("keydown", (ev) =>{
      //console.log(' >> dialog key up', ev, Object.keys(self.hotKeys))
      if (ev.ctrlKey) {
        if (this.hotKeys[ev.key]) {
          // 取消默认事件
          ev.preventDefault();
          this.hotKeys[ev.key](this, ev)
        }
      }
    });
    // 初始 参数中的按钮和快捷键
    this.cfg.menus.forEach(menu => this.add_menu(menu))
    // 默认聚焦
    this.wrq外容器.focus()
  }

  close() {
    this.wrq外容器.remove()
  }

  add_element(target) {
    this.nrq内容器.appendChild(target)
  }

  add_menu(cfg = {}) {
    let menu = document.createElement('span')
    let index = this.cdl菜单栏.childNodes.length - 1;
    cfg = Object.assign({
      title: `按钮${index}`,
      tips: `这是按钮${index}`,
      onclick: () => {
        console.log(`> ${cfg.title} ${index} is clicked`)
      },
      hotkey: `${index}`,
      style: 'color: white; cursor: pointer; marginLeft: 5px; height:100%; line-height: 90%; display: inline-block; overflow-x: hidden'
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
    this.hotKeys[cfg.hotkey] = cfg.onclick
    this.cdl菜单栏.appendChild(menu);
    return menu;
  }

  static open(cfg, cbk) {
    return new this(cfg, cbk)
  }
}

tools.dialog_tips = class extends tools.dialog {
  constructor(cfg = {}, cbk) {
    cfg = Object.assign({timeout: 3000, title: 'Tips', content: '...'}, cfg)
    super(cfg)
    let random_pos = Math.floor(Math.random() * 100) + 50;
    this.wrq外容器.style.width = ''
    this.wrq外容器.style.height = ''
    this.wrq外容器.style.maxWidth = '60%'
    this.wrq外容器.style.maxHeight = '80%'
    this.wrq外容器.style.top = `calc(5% + ${random_pos}px)`
    this.wrq外容器.style.left = `calc(30% + ${random_pos}px)`

    this.nrq内容器.readOnly = true
    this.nrq内容器.style.resize = "none"
    this.nrq内容器.style.overflow = "hidden"
    this.nrq内容器.style.display = 'flex'
    this.nrq内容器.style.justifyContent = 'center'
    this.nrq内容器.style.alignItems = 'center'
    this.bt标题.innerHTML = cfg.title + (this.bt标题.title > 1 ? ` (${this.bt标题.title})` : '');
    this.nrq内容器.innerHTML = cfg.content

    if (cfg.timeout > 0) {
      setTimeout(() => {
        cbk && cbk()
        this.close()
      }, cfg.timeout)
    }
  }

  static open(title,content,timeout = 3,cbk){
    return new this({title: title, timeout: timeout,content: content},cbk)
  }
}

tools.dialog_input = class extends tools.dialog {
  //{name title tips type default onchange}
  constructor(cfg = {}) {
    cfg = Object.assign({title: 'Input', inputs: [{name: '输入一', tips: '在这里输入'}],menus: [{
      title: '提交', tips: '提交', hotkey: 'Enter', onclick: () => {
        if (cfg.onok) {
          if (cfg.onok(this.inputs.reduce((a,c)=>{a[c.name] = c.value; return a},{}))) {
            this.close()
          }
        }else{
          this.close()
        }
      }
    }]
    }, cfg)
    super(cfg)
    this.wrq外容器.style.width = ''
    this.wrq外容器.style.height = ''
    this.wrq外容器.style.maxWidth = '60%'
    this.wrq外容器.style.maxHeight = '80%'
    this.wrq外容器.style.overflowY = 'auto'
    this.wrq外容器.style.top = '40%'
    this.wrq外容器.style.left = '40%'
    this.bt标题.innerHTML = cfg.title;
    this.inputs = []

    this.nrq内容器.style.overflow = 'hidden'
    cfg.inputs.forEach((c, i) => {
      let div = document.createElement('div');
      div.style = 'width: 100%; height: 30px; box-sizing: border-box; display: flex; justify-content: space-between; margin: 5px'
      let span = document.createElement('span');
      span.style = 'width: 30%; height: 100%; line-height: 90%'
      span.innerHTML = c.title;

      let text = document.createElement('input')
      Object.assign(text, c)
      if (c.tips) text.title = c.tips
      if(c.name){text.name = c.name}else{text.name = i}
      c.default && (text.value = c.default)
      text.style = 'width: calc(70% - 10px); height: 100%; box-sizing: border-box; margin-right: 10px'
      text.onchange = (ev) => {
        c.onchange && c.onchange(ev, this)
      }
      text.oninput = (ev) => {
        c.oninput && c.oninput(ev, this)
      }
      div.appendChild(span)
      div.appendChild(text)
      this.inputs.push(text)
      //this.wrq外容器.style.height = `${30 * (i + 2) + 20}px`
      this.nrq内容器.appendChild(div)
    })
  }

  set_value(name, value){
    let input = this.get_iterm(name);
    if (input) {
      input.value = value
      input.dispatchEvent(new Event('change',{bubbles: true, cancelable: true}))
      return value
    }
    return undefined;
  }

  get_iterm(name){
    for(let i=0; i< this.inputs.length; i++){
      if(this.inputs[i].name == name){
        return this.inputs[i];
      }
    }
    return undefined;
  }
  static open(title="输入",inputs=[{title:'姓名'}],onok=(vals)=>{console.log(vals)}){
    return new this({title, inputs: inputs, onok: onok})
  }
}

tools.dialog_file_uploader = class extends tools.dialog {
  constructor(cfg = {}, cbk) {
    //cfg = Object.assign({timeout: 3000, title: 'Tips', content: '...'}, cfg)
    super(cfg)
    this.uploader = cfg.file_uploader
    this.add_menu({
      title: '|上传|', tips: '开始上传', hotkey: 'Enter',
      onclick: ()=>{
        this.uploader.upload_init().then(_ => {
          this.uploader.start_jobs()
        })
      }
    })

    this.add_menu({
      title: '|配置|',tips: '配置上传参数', hotkey: 's',
      onclick: ()=>{
        tools.dialog_input.open('上传参数',[
          { title: '文件名称', type: 'text', default: this.uploader.uploadFile.name, readOnly: true},
          { title: '文件大小', type: 'text', default: this.uploader.uploadFile.size, readOnly: true},
          { title: '并行数量', type: 'number', min: 1, max: 64,defaultValue: this.uploader.workerSize, onchange: (ev,_)=>{this.uploader.workerSize = ev.target.value}},
          { title: '切块大小', type: 'number', min: 1024, name: 'chunkSize', defaultValue: this.uploader.chunkSize, onchange: (ev,self)=>{
            console.log("set chunkSize",ev.target.value)
            if(ev.target.value > 0){
              this.uploader.chunkSize = parseInt(ev.target.value)
              this.uploader.uploadCount = Math.ceil(this.uploader.uploadFile.size / this.uploader.chunkSize)
              self.set_value('uploadCount', this.uploader.uploadCount)
            }
          }
          },
          { title: '切块数量', type: 'number',min: 1, name: 'uploadCount', defaultValue: this.uploader.uploadCount, oninput: (ev,self)=>{
            if(ev.target.value > 0){
              this.uploader.uploadCount = parseInt(ev.target.value)
              this.uploader.chunkSize = Math.ceil(this.uploader.uploadFile.size / this.uploader.uploadCount)
              self.set_value('chunkSize', this.uploader.chunkSize)
              console.log("set chunkCount")
            }
          }, onchange: ()=>{
            this.init_bar()
          }
          },
        ],()=>this.init_bar())
      }
    })

    this.bt标题.innerHTML = this.uploader.uploadFile.name
    this.bar = document.createElement('div') ;
    this.bar.style = 'width: 100%; height:60%; border: 1px dashed green; display: flex; flex-wrap:wrap; overflow-y:scroll;background-position: center;background-repeat: no-repeat';
    this.bars = new Map();
    this.add_element(this.bar)

    let text = document.createElement('textarea')
    text.style='width:100%;height:40%;box-sizing:border-box;resize: none'
    text.readOnly = true
    this.add_element(text)
    this.uploader.triggerd = (ev, info) => {
      text.value += `${new Date().format("yyyy-MM-dd hh:mm:ss")} ${ev} ${info.opt} [${JSON.stringify(info.log)}]\r\n`
      tools.target_stillBottom_event(text)
    }
    this.uploader.on('progress', (info) => {
      if (info.opt == 'upload') {
        this.bars[info['index']].style.backgroundColor = 'blue';
      }
      if (info.opt == 'uploaded') {
        this.bt标题.innerHTML = this.uploader.uploadFile.name + `(${(this.uploader.uploaded_indexs.length / this.uploader.uploadCount * 100).toFixed(2)}%)`
        this.bars[info['index']].style.borderColor = 'green';
        this.bars[info['index']].style.backgroundColor = 'green';
        let rate = `${(this.uploader.uploaded_size / (new Date() - this.uploader.start_time) / 1024).toFixed(2)}mb/s`
        this.bt标题.innerHTML = this.uploader.uploadFile.name + `(${(this.uploader.uploaded_indexs.length / this.uploader.uploadCount * 100).toFixed(2)}%|${rate})`
        //this.bar.style.backgroundImage = `url(${tools.canvas_text(rate)})`
      }
      if (info.opt == 'finished') {
        this.bt标题.innerHTML = this.uploader.uploadFile.name + "(完成)"
        cbk && cbk(this.uploader)
        tools.dialog_tips.open('信息',`
          文件名称: ${this.uploader.uploadFile.name}<br>
          文件大小: ${this.uploader.uploadFile.size}<br>
          上传开始: ${this.uploader.start_time.format("yyyy-MM-dd hh:mm:ss")}<br>
          上传结束: ${this.uploader.end_time.format("yyyy-MM-dd hh:mm:ss")}<br>
          上传用时: ${(Math.round(this.uploader.end_time - this.uploader.start_time) / 1000)}s<br>
          平均速率: ${(this.uploader.uploadFile.size / (this.uploader.end_time - this.uploader.start_time) / 1024).toFixed(2)}mb/s
          `,0)
      }
    })
    this.uploader.on('worker', (info) => {
      if (info.opt == 'new') {
        this.bars[info['index']].style.backgroundColor = 'orange';
      }
    })
    this.uploader.on('chunk', (info) => {
      if (info.opt == 'start') {
        this.bars[info['index']].style.backgroundColor = 'red';
      }
    })

    this.init_bar()
  }

  init_bar(){
    this.bar.innerHTML = '';
    for(let i = 0; i < this.uploader.uploadCount; i++){
      let item = document.createElement('div') ;
      item.style = 'border: 1px solid red; flex: auto; margin:2px; width:2%; height:3%; flex-grow: 0'
      //item.style = 'border: 1px solid red; flex: auto; margin:2px; flex-grow: 0'
      item.id = `bar_${i}`
      this.bars[i] = item
      this.bar.appendChild(item)
    }
  }

  static open(url, file, cbk){
    return new this({
      file_uploader : new tools.file_uploader(url, file)
    }, cbk)
  }
}

tools.file_uploader = class {
  constructor(url, file, workerSize = 8, chunkSize = 1 * 1024 * 1024) {
    this.uploadUrl = url;
    this.uploadFile = file;
    this.chunkSize = chunkSize;
    this.workerSize = workerSize;
    this.fileSize = this.uploadFile.size
    this.uploadCount = Math.ceil(this.fileSize / this.chunkSize);

    this.uploaded_indexs = [];
    this.uploading_indexs = [];
    this.uploaded_size = 0;
    this.uploading_working_size = 0;

    this.callBack = new Map();
    this.triggerd = undefined

    this.start_time = undefined
    this.end_time = undefined
  }

  on(ev, func) {
    if (this.callBack.has(ev)) {
      this.callBack.get(ev).push(func)
    } else {
      this.callBack.set(ev, [func]);
    }
  }

  trigger(ev, info) {
    if (this.callBack.has(ev)) {
      this.callBack.get(ev).forEach(cbk => {
        cbk && cbk(info, ev, this);
      });
    }
    this.triggerd && this.triggerd(ev, info)
    //console.log(`${new Date().format("yyyy-MM-dd hh:mm:ss")} ${ev} [${JSON.stringify(info.log)}]`)
  }

  chunk_readAsArrayBuffer(index,start, end) {
    return new Promise((resolve, reject) => {
      //let reader = new FileReader();
      //reader.readAsArrayBuffer(this.uploadFile.slice(start, end));
      this.trigger('chunk', { opt: 'start', index: index ,log: `${this.uploadFile.name} chunk ${start}-${end} start` })
      //reader.onload = (data) => {
        let data = this.uploadFile.slice(start, end)
        this.trigger('chunk', { opt: 'done', index: index, log: `${this.uploadFile.name} chunk ${start}-${end} done` })
        resolve(data)
        // }
      // reader.onerror = (erro) => {
        //  this.trigger('chunk', { opt: 'erro', log: `${this.uploadFile.name} chunk ${start}-${end} erro` })
        //  reject(erro)
        // }
    })
  }

  upload_init() {
    return new Promise((resolve, reject) => {
      fetch(`${this.uploadUrl}/pre?fn=${this.uploadFile.name}&fs=${this.uploadFile.size}`, {
        method: 'POST'
      }).then(resp => resp.json()).then(resp => {
        this.trigger('init', { opt: 'init', log: `${this.uploadFile.name} ${resp.info}` })
        if (resp.code === 0) {
          resolve(resp)
        }
      }).catch(e => {
        this.trigger('erro', { opt: 'init', log: `${this.uploadFile.name} ${e.toString()} erro`, ext: e })
        reject(e)
      })
    })
  }

  upload_process(index) {
    return new Promise((resolve,reject)=>{
      let start = index * this.chunkSize;
      let end = (index + 1) * this.chunkSize;
      this.trigger('chunk', { opt: 'start', index: index ,log: `${this.uploadFile.name} chunk ${start}-${end} start` })
      let chunk = this.uploadFile.slice(start, end)
      this.trigger('chunk', { opt: 'done', index: index, log: `${this.uploadFile.name} chunk ${start}-${end} done` })
      this.trigger('progress', { opt: 'upload', log: `${this.uploadFile.name} uploading ${index}/${this.uploadCount}`, index: index, count: this.uploadCount })
      return fetch(`${this.uploadUrl}?fn=${this.uploadFile.name}&id=${index}&ct=${this.uploadCount}&cs=${this.chunkSize}`, {
        method: 'POST', body: chunk
      }).then(resp => resp.json()).then(resp => {
        this.uploaded_indexs.push(index)
        this.uploaded_size += chunk.size
        resolve(resp)
        this.trigger('progress', { opt: 'uploaded', log: `${this.uploadFile.name} uploaded ${index}/${this.uploadCount}`, index: index, count: this.uploadCount ,ext:resp })
        if (this.uploaded_indexs.length == this.uploadCount) {
          if(this.end_time == undefined) {
            this.end_time = new Date()
          }
          this.trigger('progress', { opt: 'finished', log: `${this.uploadFile.name} finished`, index: index })
        }
        chunk = null;
      }).catch((e) => {
        this.trigger('progress', { opt: 'retry', log: `${this.uploadFile.name} retry ${index}`, index: index, ext: e })
        //this.trigger('erro', { opt: 'upload', log: `${this.uploadFile.name} upload ${index}`, index: index, count: this.uploadCount })
        setTimeout(() => {
          this.upload_process(index, chunk);
        }, Math.round(Math.random() * 10000))
        reject(e)
      })
    })
  }

  start_jobs() {
    if(this.start_time == undefined) {
      this.start_time = new Date()
    }
    if (this.uploading_indexs.length === this.uploadCount) {
      this.trigger('worker', { opt: 'finished', log: `${this.uploadFile.name} worker finished ${this.uploaded_indexs.length}`, workerSize: this.workerSize, workingSize: this.uploading_working_size })
      return
    }
    for (let index = 0; index < this.uploadCount; index++) {
      if (this.uploading_indexs.indexOf(index) === -1) {
        if (this.uploading_working_size < this.workerSize) {
          this.uploading_working_size += 1;
          this.uploading_indexs.push(index);
          this.trigger('worker', { opt: 'new', log: `${this.uploadFile.name} worker new ${index} ${this.uploading_working_size}/${this.workerSize}=${this.uploaded_indexs.length}`, index: index, count: this.uploadCount })
          this.upload_process(index).finally(() => {
            this.uploading_working_size -= 1;
            this.trigger('worker', { opt: 'done', log: `${this.uploadFile.name} worker done ${index} ${this.uploading_working_size}/${this.workerSize}=${this.uploaded_indexs.length}`, index: index, count: this.uploadCount })
            this.start_jobs()
          })
        } else {
          this.trigger('worker', { opt: 'wait', log: `${this.uploadFile.name} worker wait ${index} ${this.uploading_working_size}/${this.workerSize}=${this.uploaded_indexs.length}`, index: index, count: this.uploadCount })
          break
        }
      }
    }
  }
}

tools.canvas_text = function (text, cfg = {}) {
  cfg = Object.assign({
    width: '320',
    height: '240',
    format: 'image/png',
    x: 40,
    y: 20,
  }, cfg)
  let canvas = document.createElement('canvas')
  let ctx = canvas.getContext('2d')
  canvas.height = cfg.height
  canvas.width = cfg.width

  ctx.textAlign = 'center'
  ctx.fillText(text, cfg.x, cfg.y)
  return canvas.toDataURL(cfg.format)
}

Date.prototype.format = function (fmt) {
  var o = {
    "M+": this.getMonth() + 1, //月份需+1
    "d+": this.getDate(),
    "h+": this.getHours(),
    "m+": this.getMinutes(),
    "s+": this.getSeconds(),
    "q+": Math.floor((this.getMonth() + 3) / 3), //季度
    "S": this.getMilliseconds()
  };
  if (/(y+)/.test(fmt))
    fmt = fmt.replace(RegExp.$1, (this.getFullYear() + "").substr(4 - RegExp.$1.length));
  for (var k in o)
    if (new RegExp("(" + k + ")").test(fmt))
      fmt = fmt.replace(RegExp.$1, (RegExp.$1.length == 1) ? (o[k]) : (("00" + o[k]).substr(("" + o[k]).length)));
  return fmt;
}

window.s = tools
