import { spawn } from 'node:child_process';
const executable=process.env.PYTHON_EXECUTABLE||(process.platform==='win32'?'py':'python3');
const child=spawn(executable,['-m','unittest','discover','-s','tests','-p','test_*.py','-v'],{stdio:'inherit',windowsHide:true});
child.on('error',()=>{console.error('Install Python and requirements.txt, or set PYTHON_EXECUTABLE to your virtual environment interpreter.');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
