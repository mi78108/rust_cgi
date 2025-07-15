WebSocket.prototype.re_try = 5
WebSocket.prototype.reconnect = function(){
	if (this.re_try > 0){
		let ws = new WebSocket(this.url);
		ws.onopen = this.ws.onopen;
		ws.onclose = this.ws.onclose;
		ws.onerror = this.ws.onerror;
		ws.onmessage = this.ws.onmessage;
		ws.re_try = this.re_try - 1
		return ws;
	}
	return this;
}
