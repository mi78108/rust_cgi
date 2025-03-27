let _storeHash = {};
let tools = {}

function log(...msg) {
    console.log(msg)
}

/**
 *
 * @param title_name
 * @param cb
 * (content,dig,close,title,...menus)=>{
 *  }
 * @param menu
 * ([{
 *      title: '关闭',
 *      hotKey: 'X', //ctrl + x
 *      onclick : (ev,span,content) =>{
 *          ...
 *      }
 *  }]
 */
tools.dialog = function(title_name,cb,menu){
    let menus = []
    let width = 60
    let dig = document.createElement("div");
    //fix 25/03/27
    dig.tabIndex = 0

    dig.style.width = width + "%"
    dig.style.height = "60%"
    dig.style.border="2px solid black" 
    dig.style.position = "fixed"
    dig.style.left = (100-width) / 2 + "%" 
    dig.style.top = "17%" 


    let head = document.createElement("div");
    let close = document.createElement("span");
    let title = document.createElement("span");
    close.innerHTML = "[X]"
    close.style.color="white"
    close.style.position = "absolute"
    close.style.right = "3px"
    close.style.cursor = "pointer"
    close.onclick = function(ev){
        console.log(' >>dialog close btn click')
        dig.remove()
    }
    title.innerHTML = title_name? title_name : "Dialog"
    title.style.color="white"
    //name.style.position = "absolute"
    title.style.left = "3px"
    head.style.width = "100%"
    head.style.height = "30px"
    head.style.border="1px solid black"
    head.style.backgroundColor = "black"
    head.style.cursor = "move"
    head.appendChild(title)
    // move
    head.onmousedown = (ev)=>{
        if (ev.button == 0){
            let x = ev.clientX;
            let y = ev.clientY;
            let oL = dig.offsetLeft;
            let oT = dig.offsetTop;
            document.onmousemove = function(e){
                let xx = e.clientX;
                let yy = e.clientY;
                dig.style.left = xx-x+oL+"px"
                dig.style.top = yy-y+oT+"px"
            }
            document.onmouseup = function(){
                document.onmousemove = null;
                document.onmouseup = null;
            }
        }
    }
    //menu
    let content = document.createElement("div");
    if(menu){
        menu.forEach((v,i)=>{
            let _m = document.createElement("span");
            _m.className = "cursor_point"
            _m.style.cursor = "pointer"
            _m.innerHTML = "["+v['title']+"]"
            _m.style.color = "white"
            //	_m.style.position = "absolute"
            _m.style.marginLeft = "5px"
            if( i == 0){
                _m.style.marginLeft = "25px"
            }
            _m.onclick = (ev) => {
                v['onclick'] && v['onclick'](ev,_m,content)
            }
            menus.push(_m)
            head.appendChild(_m)
        })
    }
    head.appendChild(close)
    // hotkey
    dig.addEventListener("keydown", function(ev) {
        console.log(' >> dialog key up',ev)
        if(ev.ctrlKey){
            if(menu.some((k,i)=>{
                if(k['hotKey'] == ev.key){
                    //if(ev.ctrlKey){
                    menus[i].onclick(ev)
                    return true
                    //}
                }
                return false
            })){
                ev.preventDefault()
            }
        }
    });

    content.style.width = "calc(100% - 5px)"
    content.style.height = "calc(100% - 35px)"
    content.style.overflowY = "auto"
    content.style.paddingLeft = "5px"
    //content.style.paddingBottom = "5px"
    content.style.backgroundColor = "white"
    // size
    content.onmousedown = (ev)=>{
        // Todo 无法判断右键单击或者右键拖拽; 目前保留拖拽功能右键单击失效
        if(ev.button == 2){
            let x = ev.clientX;
            let y = ev.clientY;
            //let oW = dig.offsetWidth;
            //let oH = dig.offsetHeight;
            let oL = dig.offsetLeft;
            let oT = dig.offsetTop;
            let flags = true
            content.style.cursor = "se-resize"
            document.oncontextmenu = ()=>false
            document.onmousemove = function(e){
                flags = false
                let xx = e.clientX;
                let yy = e.clientY;
                dig.style.width = xx-oL+30+"px"
                dig.style.height = yy-oT+30+"px"
            }
            document.onmouseup = function(e){
                if(flags){
                   document.oncontextmenu = ()=>true
                }else{
                    setTimeout(function(){
                        document.oncontextmenu = ()=>true
                    },1000)
                }
                content.style.cursor = "text"
                document.onmousemove = null;
                document.onmouseup = null;
            }
        }
    }

    dig.appendChild(head)
    dig.appendChild(content)
    window.document.body.appendChild(dig)
    //fix 25/03/27
    dig.focus()
    cb && cb(content,dig,close,title,...menus)
}

tools.dialog_input = function(cb,cfg={}){
    tools.dialog((c,n,e,d)=>{
        let ip = document.createElement('input')
        cfg['title'] && (n.innerHTML = cfg['title'])
        ip.style.width = "100%"
        ip.style.height = "30px"
        ip.addEventListener("keyup", function(event) {
            event.preventDefault();
            if (event.keyCode === 13) {
                d.remove()
                cb && cb(ip)

            }
        });
        c.appendChild(ip)
        ip.focus()
        c.style.height="32px"
        c.style.padding = "3px"
        d.style.width="40%"
        d.style.height="70px"
        d.style.top="47%"
        d.style.left="30%"
    })
}

tools.dialog_tips = function(cfg={}){
    cfg = Object.assign({timeout:2000},cfg)
    tools.dialog((c,n,e,d)=>{
        let ip = document.createElement('textarea')
        ip.style.width = "100%"
        ip.style.height = "100%"
        ip.style.resize = "none"
        ip.style.overflow = "hidden"
        ip.readOnly =true
        cfg['title'] && (n.innerHTML = cfg['title'])
        cfg['content'] && (ip.value = cfg['content'])

        c.appendChild(ip)
        c.style.height="69px"
        c.style.width="100%"
        c.style.padding = "0px"
        d.style.width="30%"
        d.style.height="100px"
        d.style.top="40%"
        d.style.left="35%"

        setTimeout(()=>{
            d.remove()
        },cfg['timeout'])
    })
}


tools.req_urlencode = function(url, params={}) {
    return fetch(url, {
        method: (params['method'] || "POST"),
        body: params['method'] == 'GET' ? undefined : Object.entries(Object.assign({
            "_uuid_": new Date().getTime(),
        }, params['body'])).reduce((a, c) => {
            a.push(encodeURIComponent(c[0]) + '=' + encodeURIComponent(c[1]))
            return a
        }, new Array()).join('&'),
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
}


tools.req = function(url,method, body={}) {
    return fetch(url, {
        method: method,
        body: method == 'GET' ? undefined : JSON.stringify(Object.assign({
            "_uuid_": new Date().getTime(),
        }, body)),
        headers: {
            'Content-Type': 'application/json'
        }
    })
}

tools.req_post = function(url, body={}) {
    console.log(body)
    return fetch(url, {
        method: "POST",
        body: JSON.stringify(Object.assign({
            "_uuid_": new Date().getTime(),
        }, body)),
        headers: {
            'Content-Type': 'application/json'
        }
    })
}

tools.req_get = function(url) {
    return fetch(url, {
        method: "GET",
        headers: {
            'Content-Type': 'application/json'
        }
    })
}

tools.upload_file_post = function (file,url){
    return fetch(url,{
        method: 'POST',
        body: file,
        headers: {
            'Upload-File-Name': file.name
        }
    })
}

tools.upload_file_formData = function (file, url){
    //formData
    let formData = new FormData();
    formData.append('file',file)
    return fetch(url,{
        method: 'POST',
        body: formData
    })
}

tools.upload_file_websocket = function (){

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
    video.style.border='thick solid #0000FF';
    video.take_photo = function(){
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


function preventAll(ev){
    ev.preventDefault()
    ev.stopPropagation()
}
