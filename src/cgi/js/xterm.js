//检查jquery
//window.jQuery || document.write("<script src='https://apps.bdimg.com/libs/jquery/2.1.4/jquery.min.js'></script>")
//
/**
 *
 */
class Xterm {
    /**
     *
     * @param node 用于容纳的容器
     * @param cb 用户输入后 提交触发
     */
    constructor(node, cb) {
        let self = this;
        this.x = 0;
        this.y = 0;
        this.cb = cb;
        this.node_dom = node;
        this.prompt = '> ';

        this.row_h = 40;

        this.table = document.createElement("table");
        this.user_input_dom = document.createElement("div");
        this.user_input_dom.id = "uip";
        this.user_input_dom.style.backgroundColor = this.node_dom.style.backgroundColor;
        this.user_input_dom.contentEditable = "true";
        this.user_input_dom.style.width = "100%";
        this.user_input_dom.style.outline = "none";
        this.user_input_dom.style.color = 'white';
        this.user_input_dom.style.minHeight = this.row_h / 2 + 'px';

        this.table.style.width = "100%";
        this.table.style.color = "white";
        this.table.style.tableLayout = "fixed";
        // this.tb.style.height = "100%";
        this.node_dom.style.overflowY = "scroll"
        this.node_dom.append(this.table);
        this.firstLine = this.insertLine(null, 0, function (v) {
            v.cells.item(0).innerHTML = self.prompt;
            v.cells.item(1).appendChild(self.user_input_dom)
        });

        this.tips_time = setInterval(() => {
            let now = new Date();
            self.firstLine.cells.item(2).innerHTML = now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds()
        }, 1000)

        //Auto focus or click
        this.node_dom.onmouseenter = function () {
            self.user_input_dom.focus()
        };
        this.node_dom.onclick = function () {
            self.user_input_dom.focus()
        };
        //HotKey
        this.user_input_dom.onkeydown = function (ev) {
            if (self.hotKey[ev.key]) {
                //console.log(ev)
                self.hotKey[ev.key](ev)
            }
        }
        self.hotKey = {
            // Default
            'Enter': function (ev) {
                //ctrl+enter 提交
                if (ev.ctrlKey) {
                    ev.preventDefault()
                    self.insertLine([`${self.user_input_dom.innerHTML}`])
                    self.cb && self.cb(self.user_input_dom.textContent);
                    //
                    self.user_input_dom.childNodes.forEach(v => v.remove());
                    self.user_input_dom.innerHTML = ''
                    return true
                }
            },
        }
    }


    insertLine(contents, rindex = 1, cb) {
        let self = this;
        let time_now = () => {
            let now = new Date();
            return now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds()
        }
        // 添加行
        let row = this.table.insertRow(this.table.rows.length - rindex);
        //rw.style.height = this.row_h + "px";
        // 添加列
        ['10px', 'calc(100% - 80px)', '70px'].forEach(function (v, i) {
            let cell = row.insertCell(i);
            if (i === 0) {
                cell.style.verticalAlign = 'top';
                cell.innerHTML = (contents && contents[1]) || self.prompt;
            }
            if (i === 1) {
                cell.innerHTML = contents && contents[0] || '';
            }
            if (i === 2) {
                cell.innerHTML = (contents && contents[2]) || time_now();
            }
            cell.style.width = v;
        });
        //still bottom
        let scrollHeight = this.node_dom.scrollHeight || 1;
        //let _dh = $(this.tdm).height();
        let domHeight = this.node_dom.height;
        let domScrollTop = this.node_dom.scrollTop;
        if (domScrollTop + domHeight + 100 > scrollHeight) {
            this.node_dom.scrollTop = scrollHeight;
        }
        cb && cb(row);
        return row;
    }

    echo(m) {
        this.insertLine([m, ' '])
    }
}


//行为单位
class Row {

}

// $.fn.extend({
//     Xterm: function (cf, cb) {
//         log(">>>>Table Init");
//         let xtm = new Xterm(this);
//         xtm.prompt = cf.prompt;
//         xtm.cb = cb;
//         return xtm;
//     },
//     log: function (m) {
//         console.log(m)
//     }
// });
