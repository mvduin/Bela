'use strict';

// worker
var worker = new Worker("js/scope-worker.js");

// models
var Model = require('./Model');
var settings = new Model();

// Pixi.js renderer and stage
var renderer = PIXI.autoDetectRenderer(window.innerWidth, window.innerHeight, {transparent: true});
renderer.view.style.position = "absolute";
renderer.view.style.display = "block";
renderer.autoResize = true;
$('.scopeWrapper').append(renderer.view);
var stage = new PIXI.Container();

// views
var controlView = new (require('./ControlView'))('scopeControls', [settings]);
var backgroundView = new (require('./BackgroundView'))('scopeBG', [settings], renderer);
var channelView = new (require('./ChannelView'))('channelView', [settings]);
var sliderView = new (require('./SliderView'))('sliderView', [settings]);

// main bela socket
var belaSocket = io('/IDE');

// scope websocket
var ws;

ws = new WebSocket("ws://192.168.7.2:5432/scope_control");
var ws_onerror = function(e){
	setTimeout(() => {
		ws = new WebSocket("ws://192.168.7.2:5432/scope_control");
		ws.onerror = ws_onerror;
		ws.onopen = ws_onopen;
		ws.onmessage = ws_onmessage;
	}, 500);
};
ws.onerror = ws_onerror;

var ws_onopen = function(){
	ws.binaryType = 'arraybuffer';
	console.log('scope control websocket open');
	ws.onclose = ws_onerror;
	ws.onerror = undefined;
};
ws.onopen = ws_onopen;

var ws_onmessage = function(msg){
	// console.log('recieved scope control message:', msg.data);
	var data;
	try{
		data = JSON.parse(msg.data);
	}
	catch(e){
		console.log('could not parse scope control data:', e);
		return;
	}
	if (data.event == 'connection'){
		delete data.event;
		data.frameWidth = window.innerWidth;
		data.frameHeight = window.innerHeight;	
		settings.setData(data);

		var obj = settings._getData();
		obj.event = "connection-reply";
		var out;
		try{
			out = JSON.stringify(obj);
		}
		catch(e){
			console.log('could not stringify settings:', e);
			return;
		}
		if (ws.readyState === 1) ws.send(out);
	} else if (data.event == 'set-slider'){
		sliderView.emit('set-slider', data);
	}
};
ws.onmessage = ws_onmessage;

var paused = false, oneShot = false;

// view events
controlView.on('settings-event', (key, value) => {
	if (key === 'scopePause'){
		if (paused){
			paused = false;
			$('#pauseButton').html('pause');
			$('#scopeStatus').html('waiting');
		} else {
			paused = true;
			$('#pauseButton').html('resume');
			$('#scopeStatus').removeClass('scope-status-triggered').addClass('scope-status-waiting').html('paused');
		}
		return;
	} else if (key === 'scopeOneShot'){
		oneShot = true;
		if (paused){
			paused = false;
			$('#pauseButton').html('pause');
		}
		$('#scopeStatus').removeClass('scope-status-triggered').addClass('scope-status-waiting').html('waiting (one-shot)');
	}
	if (value === undefined) return;
	var obj = {};
	obj[key] = value;
	var out;
	try{
		out = JSON.stringify(obj);
	}
	catch(e){
		console.log('error creating settings JSON', e);
		return;
	}
	if (ws.readyState === 1) ws.send(out);
	settings.setKey(key, value);
});

channelView.on('channelConfig', (channelConfig) => {
	worker.postMessage({
		event			: 'channelConfig',
		channelConfig
	});
});

sliderView.on('slider-value', (slider, value) => {
	var obj = {event: "slider", slider, value};
	var out;
	try{
		out = JSON.stringify(obj);
	}
	catch(e){
		console.log('could not stringify slider json:', e);
		return;
	}
	if (ws.readyState === 1) ws.send(out)
});

belaSocket.on('cpu-usage', CPU);

// model events
settings.on('set', (data, changedKeys) => {
	if (changedKeys.indexOf('frameWidth') !== -1){
		var xTimeBase = Math.max(Math.floor(1000*(data.frameWidth/8)/data.sampleRate), 1);
		settings.setKey('xTimeBase', xTimeBase);
		var out;
		try{
			out = JSON.stringify({frameWidth: data.frameWidth});
		}
		catch(e){
			console.log('unable to stringify framewidth', e);
			return;
		}
		if (ws.readyState === 1) ws.send(out);
	} else {
		worker.postMessage({
			event		: 'settings',
			settings	: data
		});
	}
});

// window events
$(window).on('resize', () => {
	settings.setKey('frameWidth', window.innerWidth);
	settings.setKey('frameHeight', window.innerHeight);
});

$(window).on('mousemove', e => {
	if (settings.getKey('plotMode') === undefined) return;
	var plotMode = settings.getKey('plotMode');
	var scale = settings.getKey('downSampling') / settings.getKey('upSampling');
	var x, y;
	if (plotMode == 0){
		x = (1000*scale*(e.clientX-window.innerWidth/2)/settings.getKey('sampleRate')).toPrecision(4)+'ms';
		y = (1 - 2*e.clientY/window.innerHeight).toPrecision(3);
	} else if (plotMode == 1){
		if (parseInt(settings.getKey('FFTXAxis')) === 0){
			x = parseInt(settings.getKey('sampleRate')*e.clientX/(2*window.innerWidth*scale));
		} else {
			x = parseInt(Math.pow(Math.E, -(Math.log(1/window.innerWidth))*e.clientX/window.innerWidth) * (settings.getKey('sampleRate')/(2*window.innerWidth)) * (settings.getKey('upSampling')/(settings.getKey('downSampling'))));
		}
		if (x > 1500) x = (x/1000) + 'khz';
		else x += 'hz';
		y = (1 - e.clientY/window.innerHeight).toPrecision(3);
	}
	$('#scopeMouseX').html('x: '+x);
	$('#scopeMouseY').html('y: '+y);
});

// CPU usage
function CPU(data){
	var ide = (data.syntaxCheckProcess || 0) + (data.buildProcess || 0) + (data.node || 0);
	var bela = 0, rootCPU = 1;

	if (data.bela != 0 && data.bela !== undefined){
	
		// extract the data from the output
		var lines = data.bela.split('\n');
		var taskData = [], output = [];
		for (var j=0; j<lines.length; j++){
			taskData.push([]);
			lines[j] = lines[j].split(' ');
			for (var k=0; k<lines[j].length; k++){
				if (lines[j][k]){
					taskData[j].push(lines[j][k]);
				}
			}
		}
			
		for (var j=0; j<taskData.length; j++){
			if (taskData[j].length){
				var proc = {
					'name'	: taskData[j][8],
					'cpu'	: taskData[j][7],
					'msw'	: taskData[j][2],
					'csw'	: taskData[j][3]
				};
				if (proc.name === '[ROOT]') rootCPU = proc.cpu*0.01;
				// ignore uninteresting data
				if (proc && proc.name && proc.name !== '[ROOT]' && proc.name !== 'NAME' && proc.name !== '[IRQ16:'){
					output.push(proc);
				}
			}
		}

		for (var j=0; j<output.length; j++){
			if (output[j].cpu){
				bela += parseFloat(output[j].cpu);
			}
		}

		bela += data.belaLinux * rootCPU;	

	}

	$('#ide-cpu').html('IDE: '+(ide*rootCPU).toFixed(1)+'%');
	$('#bela-cpu').html('Bela: '+( bela ? bela.toFixed(1)+'%' : '--'));
	
	if (bela && (ide*rootCPU + bela) > 80){
		$('#ide-cpu, #bela-cpu').css('color', 'red');
	} else {
		$('#ide-cpu, #bela-cpu').css('color', 'black');
	}
}

// plotting
{
	let ctx = new PIXI.Graphics;
	stage.addChild(ctx);
	
	let width, height, numChannels, channelConfig = [], xOff = 0, triggerChannel = 0, triggerLevel = 0, xOffset = 0, upSampling = 1;;
	settings.on('change', (data, changedKeys) => {
		if (changedKeys.indexOf('frameWidth') !== -1 || changedKeys.indexOf('frameHeight') !== -1){
			width = window.innerWidth;
			height = window.innerHeight;
			renderer.resize(width, height);
		}
		if (changedKeys.indexOf('numChannels') !== -1){
			numChannels = data.numChannels;
		}
		if (changedKeys.indexOf('triggerChannel') !== -1){
			triggerChannel = data.triggerChannel;
		}
		if (changedKeys.indexOf('triggerLevel') !== -1){
			triggerLevel = data.triggerLevel;
		}
		if (changedKeys.indexOf('xOffset') !== -1){
			xOffset = data.xOffset;
		}
		if (changedKeys.indexOf('upSampling') !== -1){
			upSampling = data.upSampling;
		}
	});
	channelView.on('channelConfig', (config) => channelConfig = config );
	
	let frame, length, plot = false;

	worker.onmessage = function(e) {
		frame = e.data;
		length = Math.floor(frame.length/numChannels);
		// if scope is paused, don't set the plot flag
		plot = !paused;
		
		// interpolate the trigger sample to get the sub-pixel x-offset
		if (settings.getKey('plotMode') == 0){
			if (upSampling == 1){
				let one = Math.abs(frame[Math.floor(triggerChannel*length+length/2)+xOffset-1] + (height/2) * ((channelConfig[triggerChannel].yOffset + triggerLevel)/channelConfig[triggerChannel].yAmplitude - 1));
				let two = Math.abs(frame[Math.floor(triggerChannel*length+length/2)+xOffset] + (height/2) * ((channelConfig[triggerChannel].yOffset + triggerLevel)/channelConfig[triggerChannel].yAmplitude - 1));
				xOff = (one/(one+two)-1.5);
			} else {
				for (var i=0; i<=(upSampling*2); i++){
					let one = frame[Math.floor(triggerChannel*length+length/2)+xOffset*upSampling-i] + (height/2) * ((channelConfig[triggerChannel].yOffset + triggerLevel)/channelConfig[triggerChannel].yAmplitude - 1);
					let two = frame[Math.floor(triggerChannel*length+length/2)+xOffset*upSampling+i] + (height/2) * ((channelConfig[triggerChannel].yOffset + triggerLevel)/channelConfig[triggerChannel].yAmplitude - 1);
					if ((one > triggerLevel && two < triggerLevel) || (one < triggerLevel && two > triggerLevel)){
						xOff = i*(Math.abs(one)/(Math.abs(one)+Math.abs(two))-1);
						break;
					}
				}
			}
			//console.log(xOff);
		}
	};
	
	function plotLoop(){
		requestAnimationFrame(plotLoop);
	// console.log(channelConfig[0].color.replace('#', '0x'));	
		if (plot){
		
			plot = false;
			ctx.clear();
			//console.log('plotting');
			
			for (var i=0; i<numChannels; i++){

				ctx.lineStyle(1, channelConfig[i].color, 1);
	
				// ctx.beginPath();
				ctx.moveTo(0, frame[i * length] + xOff*(frame[i * length + 1] - frame[i * length]));
				
				for (var j=1; (j-xOff)<(length); j++){
					ctx.lineTo(j-xOff, frame[j+i*length]);
				}
				//ctx.lineTo(length, frame[length*(i+1)-1]);
				//if (!i) console.log(length, j-xOff-1);

				// ctx.stroke();
		
			}
			
			renderer.render(stage);

			triggerStatus();
		
		} /*else {
			console.log('not plotting');
		}*/
		
	}
	plotLoop();
	
	// update the status indicator when triggered
	let triggerTimeout; 
	let inactiveTimeout = setTimeout(() => {
		if (!oneShot && !paused) inactiveOverlay.addClass('inactive-overlay-visible');
	}, 5000);
	let scopeStatus = $('#scopeStatus');
	let inactiveOverlay = $('#inactive-overlay');
	function triggerStatus(){
	
		scopeStatus.removeClass('scope-status-waiting');
		inactiveOverlay.removeClass('inactive-overlay-visible');
			
		// hack to restart the fading animation if it is in progress
		if (scopeStatus.hasClass('scope-status-triggered')){
			scopeStatus.removeClass('scope-status-triggered');
			void scopeStatus[0].offsetWidth;
		}
		
		scopeStatus.addClass('scope-status-triggered').html('triggered');
		
		if (oneShot){
			oneShot = false;
			paused = true;
			$('#pauseButton').html('resume');
			scopeStatus.removeClass('scope-status-triggered').addClass('scope-status-waiting').html('paused');
		} else {
			if (triggerTimeout) clearTimeout(triggerTimeout);
			triggerTimeout = setTimeout(() => {
				if (!oneShot && !paused) scopeStatus.removeClass('scope-status-triggered').addClass('scope-status-waiting').html('waiting');
			}, 1000);
			
			if (inactiveTimeout) clearTimeout(inactiveTimeout);
			inactiveTimeout = setTimeout(() => {
				if (!oneShot && !paused) inactiveOverlay.addClass('inactive-overlay-visible');
			}, 5000);
		}
	}
	
	let saveCanvasData =  document.getElementById('saveCanvasData');		
	saveCanvasData.addEventListener('click', function(){

		let downSampling = settings.getKey('downSampling');
		let upSampling = settings.getKey('upSampling');
		let sampleRate = settings.getKey('sampleRate');
		let plotMode = settings.getKey('plotMode');
		let scale = downSampling/upSampling;
		let FFTAxis = settings.getKey('FFTXAxis');
		
		// console.log(FFTAxis)
				
		let out = "data:text/csv;charset=utf-8,";
		
		for (let i=0; i<length; i++){
		
			if (plotMode === 0){		// time domain
				out += scale*i/sampleRate;
			} else if (plotMode === 1) {	// FFT
				
				if (parseInt(settings.getKey('FFTXAxis')) === 0){ // linear x-axis
					out += sampleRate*i/(2*length*scale);
					// x = parseInt(settings.getKey('sampleRate')*e.clientX/(2*window.innerWidth*scale));
				} else {
					out += Math.pow(Math.E, -(Math.log(1/length))*i/length) * sampleRate/(2*length) + upSampling/downSampling;
					// x = parseInt(Math.pow(Math.E, -(Math.log(1/window.innerWidth))*e.clientX/window.innerWidth) * (settings.getKey('sampleRate')/(2*window.innerWidth)) * (settings.getKey('upSampling')/(settings.getKey('downSampling'))));
				}
				
			}
			
			for (let j=0; j<numChannels; j++){
				out += ','+ ( ( 1 - frame[j*length + i] / (height/2) ) * channelConfig[j].yAmplitude - channelConfig[j].yOffset );
			}
			out += '\n';
		}


		this.href = encodeURI(out);
	});
	
}

settings.setData({
	numChannels	: 2,
	sampleRate	: 44100,
	numSliders	: 0,
	frameWidth	: 1280,
	plotMode	: 0,
	triggerMode	: 0,
	triggerChannel	: 0,
	triggerDir	: 0,
	triggerLevel	: 0,
	xOffset		: 0,
	upSampling	: 1,
	downSampling	: 1,
	FFTLength	: 1024,
	FFTXAxis	: 0,
	FFTYAxis	: 0,
	holdOff		: 0,
	numSliders	: 0,
	interpolation	: 0
});







